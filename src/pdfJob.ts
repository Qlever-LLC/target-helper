/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// eslint-disable-next-line unicorn/import-style
import { join } from "node:path";
import type { Change, JsonObject, OADAClient } from "@oada/client";
import { connect } from "@oada/client";
import type { Job, Json, WorkerFunction } from "@oada/jobs";
import { AssumeState, ChangeType, ListWatch } from "@oada/list-lib";
import type { Logger } from "@oada/pino-debug";
import type { Link } from "@oada/types/oada/link/v1.js";
import type Resource from "@oada/types/oada/resource.js";
import type Update from "@oada/types/oada/service/job/update.js";
import { assert as assertJob } from "@oada/types/oada/service/job.js";
import oError from "@overleaf/o-error";
import debug from "debug";
import moment from "moment";
import config from "./config.js";

import { fromOadaType } from "./conversions.js";
import { handleShares, recursiveSignLinks } from "./pdfJobPostProc.js";
import type { TreeKey } from "./tree.js";
import {
  selfDocumentTypeTree,
  tpDocsTree,
  tpDocumentTypeTree,
  tpTree,
  tree,
} from "./tree.js";
import {
  recursiveMakeAllLinksVersioned,
  recursiveReplaceLinksWithReferences,
  stripResource,
} from "./utils.js";

const error = debug("target-helper:error");
const info = debug("target-helper:info");
const trace = debug("target-helper:trace");

const pending = "/bookmarks/services/target/jobs/pending";

const targetTimeout = config.get("timeouts.pdf");

type List<T> = Record<string, T>;

const tradingPartnersEnabled = config.get("tradingPartnersEnabled");
const CONCURRENCY = config.get("oada.concurrency");
const TP_PATH = "/bookmarks/trellisfw/trading-partners";

// Will fill in expandIndex on first job to handle
let expandIndex: ExpandIndex;

/**
 * Receive the job from oada-jobs
 */
export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  trace({ job }, "Received job");
  // Until oada-jobs adds cross-linking, make sure we are linked under the PDF's jobs
  trace("Linking job under pdf/_meta until oada-jobs can do that natively");
  // TODO: This seems broken when it writes to the target job
  const jobKey = jobId.replace(/^resources\//, "");
  await oada.put({
    path: `${pending}/${jobKey}/config/pdf/_meta/services/target/jobs`,
    data: {
      [jobKey]: { _ref: `${jobId}` },
    },
  });

  // Setup Expand index
  if (!expandIndex) {
    trace("First time through, fetching expandIndex");
    const { data: holders } = (await oada.ensure({
      path: "/bookmarks/trellisfw/coi-holders/expand-index",
      data: {},
      tree,
    })) as { data: Record<string, Record<string, unknown>> };
    const { data: partners } = (await oada.get({
      path: "/bookmarks/trellisfw/trading-partners/_meta/indexings/expand-index",
    })) as unknown as {
      data: Record<
        string,
        { id: string; facilities?: Record<string, { _id: string }> }
      >;
    };
    expandIndex = {
      "coi-holders": holders,
      "trading-partners": partners,
    };
  }

  return handleJob({ jobId, log, oada, onTargetSuccess: targetSuccess });
};

async function targetSuccess({
  jobId,
  log,
  oada,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
}): Promise<Json> {
  void log.info(
    "helper-started",
    "Target returned success, target-helper picking up",
  );

  // Get the latest copy of job
  const r = await oada.get({ path: `/${jobId}` });
  assertJob(r.data);
  const job = r.data as unknown as TargetJob;
  const pdfId = job.config.pdf._id;

  // ------------- 1: get result from targetResult
  job.result = await composeResult(jobId, job, oada, log);

  // ------------- 2: sign audit/coi/etc.
  void log.info("helper: signing all links in result", {});
  await recursiveSignLinks(job.result, oada, log);

  // ------------- 3: make all result links versioned for some reason
  const versionedResult = recursiveMakeAllLinksVersioned(job.result) as Record<
    TreeKey,
    Record<string, unknown>
  >;
  trace(versionedResult, "all versioned links to bookmarks");

  // ------------- 3.5 put audits/cois/etc. to proper home
  // TODO: This used to be the description for #3, but that's not what the
  // code actually did. Do we need to "put docs to their proper homes"?

  // ------------- 4: cross link vdoc for pdf <-> audits,cois,letters,etc.
  void log.info(
    "link-refs-pdf",
    "helper: linking result _refs under <pdf>/_meta/vdoc",
  );

  const vdoc = recursiveReplaceLinksWithReferences(job.result);
  info(
    "Linking _ref's into pdf/_meta, job.result before: %O, after: %O",
    job.result,
    vdoc,
  );
  await oada.put({
    path: `/${pdfId}/_meta`,
    data: {
      // E.g., fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
      vdoc: vdoc as Json,
    },
  });

  // HARDCODED UNTIL AINZ IS UPDATED:
  // ------------- 6: lookup shares, post job to shares service
  await handleShares(job, expandIndex, oada, log);

  void log.info("done", "Completed all helper tasks");

  return job.result as Json;
}

// If/when a result that matches the input partial json is found,
// merge the resource created by target into the partial json.
// Do this all first and store it as the result for the remaining steps
// to use.
export async function composeResult(
  jobId: string,
  job: TargetJob,
  oada: OADAClient,
  log: Logger,
) {
  job.result = {};

  for await (const [documentType, data] of Object.entries(job.targetResult)) {
    info("Document identified as %s", documentType);

    job.result[documentType] = {};

    for await (const documentData of Object.values(data)) {
      trace(
        "Merging from %s to %s.",
        documentData._id,
        job.config.document._id,
      );
      const { data: documentResource } = await oada.get({
        path: `/${documentData._id}`,
      });
      await oada.put({
        path: `/${job.config.document._id}`,
        data: stripResource(documentResource as JsonObject),
      });

      job.result[documentType] = {
        ...job.result[documentType],
        // Write the target data to the original document
        [job.config.docKey]: { _id: job.config.document._id },
      };
    }
  }

  // Record the result in the job
  await oada.put({
    path: `/${jobId}`,
    data: {
      result: job.result as Json,
    },
  });
  void log.trace("composed result after processing targetResult", {});

  return job.result;
}

async function handleTargetTimeout({
  jobId,
  oada,
}: {
  jobId: string;
  oada: OADAClient;
}) {
  const { data } = (await oada.get({ path: `/${jobId}` })) as unknown as {
    data: Job;
  };
  if (!data?.status) {
    // Handle timeout here
    await oada.post({
      path: `/${jobId}/updates`,
      data: {
        status: "error",
        information: "TimeoutError",
        meta: "Target took too long",
      },
    });
    // You can also throw an error or perform any other necessary actions
  }
}

async function jobChange({
  jobId,
  log,
  oada,
  c,
  unwatch,
  onTargetSuccess,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  c: Omit<Change, "resource_id">;
  unwatch: () => Promise<void>;
  onTargetSuccess: ({
    jobId,
    oada,
    log,
  }: {
    jobId: string;
    oada: OADAClient;
    log: Logger;
  }) => Promise<Json>;
}) {
  trace("#jobChange: received change, c = %O ", c);
  if (c.path !== "") {
    return; // Child
  }

  if (c.type !== "merge") {
    return; // Delete
  }

  const { updates } = (c.body ?? {}) as {
    updates?: Record<string, Update>;
  };
  if (!updates) {
    // Not an update from target
    return;
  }

  trace("#jobChange: it is a change we want (has an update)");
  for await (const v of Object.values(updates)) {
    // We have one change that has time as a stringified unix timestamp.
    // I think target posts it: "information": "Job result loaded to resource: '281aZusXonG7b7ZYY5w8TCteDcZ'",
    // "time": "1650386464"
    // It throws a horrible deprecation warning, so address it here.
    if (Number.parseInt(v.time, 10)) {
      v.time = moment(Number.parseInt(v.time, 10) * 1000).toISOString();
    }

    const t = structuredClone(v.time);
    v.time = moment(v.time).toISOString();
    if (v.time === null) {
      // @ts-expect-error --- ?
      v.time = moment(t, "X");
    }

    trace(v, "#jobChange: change update");
    switch (v.status) {
      // Fix for Target identifying loop
      case "identifying": {
        setTimeout(async () => {
          await handleTargetTimeout({ jobId, oada });
          await unwatch();
        }, targetTimeout);

        break;
      }

      case "success": {
        trace("#jobChange: unwatching job and moving on with success tasks");
        await unwatch();

        return onTargetSuccess({
          jobId,
          log,
          oada,
        });
      }

      case "error": {
        error("#jobChange: unwatching job and moving on with error tasks");
        await unwatch();
        if (v.information) {
          error("Target job [%s] failed: %O", jobId, v.information);
        }

        throw new Error(`Target job ${jobId} returned an error`, { cause: v });
      }

      default:
      // Do nothing?
    }
  }

  // eslint-disable-next-line unicorn/no-useless-undefined
  return undefined;
}

export async function handleJob({
  jobId,
  log,
  oada,
  onTargetSuccess,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  onTargetSuccess: ({
    jobId,
    oada,
    log,
  }: {
    jobId: string;
    oada: OADAClient;
    log: Logger;
  }) => Promise<Json>;
  // @ts-expect-error rewrite differently?
}): Promise<Json> {
  try {
    const { changes } = await oada.watch({
      path: `/${jobId}`,
      type: "single",
    });

    const unwatch = async () => {
      await changes.return?.();
    };

    // Create a synthetic change for the current state of things when the job starts
    await makeSyntheticChange({
      jobId,
      log,
      oada,
      unwatch,
      onTargetSuccess,
    });

    for await (const change of changes) {
      const result = await jobChange({
        jobId,
        log,
        oada,
        c: change,
        unwatch,
        onTargetSuccess,
      });
      if (result !== undefined) {
        return result;
      }
    }
  } catch (cError: unknown) {
    throw new Error(`Error handling job ${jobId}`, { cause: cError });
  }
}

async function makeSyntheticChange({
  jobId,
  log,
  oada,
  unwatch,
  onTargetSuccess,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  unwatch: () => Promise<void>;
  onTargetSuccess: ({
    jobId,
    oada,
    log,
  }: {
    jobId: string;
    oada: OADAClient;
    log: Logger;
  }) => Promise<Json>;
}): Promise<void> {
  const { data } = await oada.get({
    path: `/${jobId}`,
  });
  // Initially just the original job is the "body" for a synthetic change
  const w = data as Change["body"];

  if (w instanceof Uint8Array) {
    throw new TypeError("body is binary, cannot call jobChange");
  }

  await jobChange({
    jobId,
    log,
    oada,
    c: {
      path: "",
      body: w,
      type: "merge",
    },
    unwatch,
    onTargetSuccess,
  });
}

// -------------------------------------------------------------------------------------------------------
// Start watching /bookmarks/trellisfw/documents and create target jobs for each new one
export async function startJobCreator({
  domain,
  token,
}: {
  domain: string;
  token: string;
}) {
  try {
    info(`Connecting to DOMAIN ${domain} with concurrency ${CONCURRENCY}`);
    const con = await connect({ domain, token, concurrency: CONCURRENCY });

    await cleanupBrokenLinks();
    setInterval(cleanupBrokenLinks, 600_000);

    await con.ensure({
      path: TP_PATH,
      data: {},
      tree,
    });

    await con.ensure({
      path: "/bookmarks/trellisfw/coi-holders",
      data: {},
      tree,
    });

    // Adding these trees because the recursiveGet within ListWatch recurses too deep otherwise
    trace("Trading partners enabled %s", tradingPartnersEnabled);
    if (tradingPartnersEnabled) {
      const tpWatch = new ListWatch({
        path: TP_PATH,
        conn: con,
        resume: false,
        onNewList: AssumeState.New,
        tree: tpTree,
      });
      tpWatch.on(ChangeType.ItemAdded, watchTp);
      process.on("beforeExit", async () => tpWatch.stop());
    }

    // Ensure the documents endpoint exists because Target is an enabler of that endpoint
    const path = "/bookmarks/trellisfw/documents";
    await con.ensure({
      path,
      data: {},
      tree,
    });

    // Watch primary user's documents
    const selfDocumentsTypesWatch = new ListWatch<Resource>({
      path,
      conn: con,
      resume: false,
      onNewList: AssumeState.New,
      tree: selfDocumentTypeTree,
    });
    selfDocumentsTypesWatch.on(ChangeType.ItemAdded, documentTypeAdded());
    process.on("beforeExit", async () => selfDocumentsTypesWatch.stop());

    // eslint-disable-next-line no-inner-declarations
    async function cleanupBrokenLinks() {
      await con.ensure({
        path: pending,
        data: {},
        tree,
      });
      const { data: pendingJobs = {} } = (await con.get({
        path: pending,
      })) as unknown as { data: Record<string, Job & { _rev: string }> };

      let count = 0;
      await Promise.all(
        Object.entries<Job & { _rev: string }>(pendingJobs).map(
          async ([key, job]) => {
            if (key.startsWith("_")) {
              return;
            }

            if (Object.keys(job).length === 1 && job._rev) {
              count++;
              info(
                `cleaning up broken job ${pending}/${key} (total: ${count})`,
              );
              await con.delete({
                path: `${pending}/${key}`,
              });
            }
          },
        ),
      );
      // Info(`Done cleaning up ${count} target jobs`);
    }

    // For each trading partner, watch their documents list
    // eslint-disable-next-line no-inner-declarations
    async function watchTp({ pointer: masterId }: { pointer: string }) {
      masterId = masterId.replace(/^\//, "");
      // FOR DEBUGGING:
      // if (masterId!== 'd4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e') return
      info(`New trading partner detected at key: [${masterId}]`);
      const documentsPath = join(
        TP_PATH,
        masterId,
        "/shared/trellisfw/documents",
      );
      await con.ensure({
        path: documentsPath,
        data: {},
        tree: tpDocsTree,
      });
      info("Starting listwatch on %s", documentsPath);
      const docsWatch = new ListWatch<Resource>({
        path: documentsPath,
        onNewList: AssumeState.New,
        conn: con,
        resume: false,
        tree: tpDocsTree,
      });
      docsWatch.on(ChangeType.ItemAdded, documentTypeAdded(masterId));
      process.on("beforeExit", async () => docsWatch.stop());
    }

    // Now watch documents of that type
    // eslint-disable-next-line no-inner-declarations
    function documentTypeAdded(masterid?: string) {
      return async ({
        item: itProm,
        pointer: docType,
      }: {
        item: Promise<Resource>;
        pointer: string;
      }) => {
        const item = await itProm;
        trace({ item, docType }, "documentTypeAdded");
        const documentPath = masterid
          ? join(TP_PATH, masterid, "/shared/trellisfw/documents", docType)
          : join("/bookmarks/trellisfw/documents", docType);
        docType = docType.replace(/^\//, "");
        info("Starting trading partner doc type listwatch on %s", documentPath);
        // Register new watch on
        const docTypeWatch = new ListWatch<Resource>({
          path: documentPath,
          name: "target-helper-tp-docs",
          onNewList: AssumeState.Handled,
          conn: con,
          resume: true,
          tree: tpDocumentTypeTree,
          // PersistInterval: PERSIST_INTERVAL,
        });
        docTypeWatch.on(ChangeType.ItemAdded, documentAdded(docType, masterid));
        /*
          We cannot use this one unless we can identify our own target-helper-induced changes
          and filter them out of being handled here.
        docTypeWatch.on(
          ChangeType.ItemChanged,
          documentAdded(docType, masterid)
        );
        */
        process.on("beforeExit", async () => docTypeWatch.stop());
      };
    }

    // eslint-disable-next-line no-inner-declarations
    function documentAdded(documentType: string, masterid?: string) {
      return async ({
        item: itProm,
        pointer: key,
        change,
      }: {
        item: Promise<Resource>;
        pointer: string;
        change?: Change;
      }) => {
        try {
          let item: Resource;
          if (change) {
            const resp = await con.get({ path: change.resource_id });
            item = resp.data as Resource;
          } else {
            item = await itProm;
          }

          const { _id } = item;
          const typePath = masterid
            ? `${TP_PATH}/${masterid}/shared/trellisfw/documents/${documentType}`
            : `/bookmarks/trellisfw/documents/${documentType}`;
          key = key.replace(/^\//, "");
          const { data: meta } = (await con.get({
            path: `${typePath}/${key}/_meta`,
          })) as {
            data?: {
              services?: Record<string, unknown>;
              vdoc?: { pdf?: Record<string, unknown> };
            };
          };

          if (meta?.services?.["target-helper"]) {
            info(
              "target-helper has already been here. %s. Skipping this document",
              meta.services["target-helper"],
            );
            return;
          }

          // FIXME: For now, take the first pdf
          if (!meta?.vdoc?.pdf) {
            info("No /_meta/vdoc/pdf. Skipping this doc");
            return;
          }

          const pdfs = Object.values(meta.vdoc.pdf);
          const pdf = pdfs[0];
          info(
            `New Document was for ${
              masterid ? `tp with masterid=${masterid}` : "Non-Trading Partner"
            }`,
          );
          info("New Document posted at %s/%s", typePath, key);

          // Fetch the PDF Document
          //          let docs = Object.entries(meta!.vdoc || {});

          const data = {
            "trading-partner": masterid, // Just for documentation
            type: "transcription",
            service: "target",
            config: {
              type: "pdf",
              pdf,
              document: { _id },
              docKey: key,
              "document-type": fromOadaType(documentType)?.name ?? "unknown",
              "oada-doc-type": documentType,
            },
            _type: "application/vnd.oada.job.1+json",
          };

          try {
            const { headers } = await con.post({
              path: "/resources",
              contentType: "application/vnd.oada.job.1+json",
              data: data as Json,
            });
            const jobkey = headers["content-location"]!.replace(
              /^\/resources\//,
              "",
            );

            info("Posted job resource, jobkey = %s", jobkey);
            try {
              await con.put({
                path: pending,
                tree,
                data: {
                  [jobkey]: {
                    _id: `resources/${jobkey}`,
                    _rev: 0,
                  },
                },
              });
              trace("Posted new PDF document to target task queue");
            } catch (cError: unknown) {
              throw oError.tag(
                cError as Error,
                "Failed to PUT job link under target job queue for job key ",
                jobkey,
              );
            }
          } catch (cError: unknown) {
            throw oError.tag(
              cError as Error,
              "Failed to create new job resource for item ",
              _id,
            );
          }
        } catch (cError: unknown) {
          error(cError);
        }
      };
    }
  } catch (cError: unknown) {
    oError.tag(cError as Error, "ListWatch failed!");
    throw cError;
  }
}

interface ExpandIndexItem {
  id: string;
  facilities?: Record<string, { _id: string }>;
}
export interface ExpandIndex {
  "trading-partners": Record<string, ExpandIndexItem>;
  "coi-holders": Record<string, Record<string, unknown>>;
}

export interface TargetJobConfig {
  type: "pdf";
  pdf: {
    _id: string;
  };
  document: {
    _id: string;
  };
  docKey: string;
  "document-type": string;
  "oada-doc-type": string;
}

export interface TargetJob {
  config: TargetJobConfig;
  "trading-partner"?: string;
  targetResult: List<List<Link>>;
  result: List<List<Link>>;
}
