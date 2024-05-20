/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * OADA certificates
 */
declare module '@oada/oada-certs' {
  /**
   * JSON Web Key
   */
  export interface JWK {
    kty: string;
    use?: string;
    key_ops?: string[];
    alg?: string;
    kid?: string;
    jku?: string;
    n?: string;
    e?: string;
    d?: string;
  }
  type JWKPrivate = 'd';

  declare namespace OADACerts {
    async function pubFromPriv<K extends JWK>(
      key: K,
    ): Promise<Omit<K, JWKPrivate>>;
  }
  export = OADACerts;
}

/**
 * Trellis signatures
 */
declare module '@trellisfw/signatures' {
  import type OADACerts, { JWK } from '@oada/oada-certs';

  declare namespace TrellisSignatures {
    async function sign<T>(
      jsonObject: T,
      privateJWK: JWK,
      headers: Record<string, unknown>,
    ): Promise<T & { signatures: string[] }>;

    async function verify<T extends { signatures?: string[] }>(
      jsonObject: T,
      // TODO: what is this?
      options?: unknown,
    ): Promise<{
      valid: boolean;
      trusted: boolean;
      unchanged: boolean;
      payload: Record<string, unknown>;
      messages: string[];
      original: T;
    }>;
    const keys: typeof OADACerts;
  }
  export = TrellisSignatures;

  export type { JWK } from '@oada/oada-certs';
}
