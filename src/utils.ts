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

/**
 * Helper because TS is dumb and doesn't realize `in` means the key definitely exists.
 */
export function has<T, K extends string>(
  value: T,
  key: K,
): value is T & { [P in K]: unknown } {
  return value && typeof value === 'object' && key in value;
}

// Because OADA resource keys are always in the way
export function stripResource<
  T extends
    | {
        _id?: unknown;
        _rev?: unknown;
        _meta?: unknown;
        _type?: unknown;
        _ref?: unknown;
      }
    | undefined,
>(resource: T) {
  if (!resource) {
    return resource;
  }

  const { _id, _rev, _meta, _type, _ref, ...rest } = resource;
  return rest;
}

export function recursiveMakeAllLinksVersioned(object: unknown): unknown {
  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (has(object, '_id')) {
    return {
      _id: object._id as string,
      _rev: 0,
    };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      recursiveMakeAllLinksVersioned(value),
    ]),
  );
}

export function recursiveReplaceLinksWithReferences(object: unknown): unknown {
  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (has(object, '_id')) {
    return { _ref: object._id as string };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      recursiveReplaceLinksWithReferences(value),
    ]),
  );
}

export function treeForDocumentType(doctype: string) {
  let singularType = doctype;
  if (singularType.endsWith('s')) {
    // If it ends in 's', easy fix
    singularType = singularType.replace(/s$/, '');
  } else if (singularType.includes('-')) {
    // If it has a dash, maybe it is like letters-of-guarantee (first thing plural)
    const parts = singularType.split('-');
    if (parts[0]?.match(/s$/)) {
      parts[0] = parts[0].replace(/s$/, '');
    } else {
      throw new Error(
        `ERROR: doctype ${doctype} has dashes, but is not easily convertible to singular word for _type`,
      );
    }

    singularType = parts.join('-');
  } else {
    throw new Error(
      `ERROR: doctype ${doctype} is not easily convertible to singular word for _type`,
    );
  }

  return {
    bookmarks: {
      _type: 'application/vnd.oada.bookmarks.1+json',
      trellisfw: {
        _type: 'application/vnd.trellis.1+json',
        [doctype]: {
          // Cois, fsqa-audits, etc.
          '_type': `application/vnd.trellis.${doctype}.1+json`, // Plural word: cois, letters-of-guarantee
          '*': {
            _type: `application/vnd.trellis.${singularType}.1+json`, // Coi, letter-of-guarantee
            _rev: 1, // Links within each type of thing are versioned
          },
        },
      },
    },
  };
}
