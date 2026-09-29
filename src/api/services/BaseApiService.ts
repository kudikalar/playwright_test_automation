/** Shared behaviour for domain API services: a client, a logger and a name for diagnostics. */

import type { ApiClient } from '../clients/ApiClient';
import { createLogger, type Logger } from '../../utils/Logger';

export abstract class BaseApiService {
  protected readonly client: ApiClient;
  protected readonly log: Logger;

  constructor(client: ApiClient) {
    this.client = client;
    this.log = createLogger(new.target.name);
  }

  /** The client this service wraps, for hybrid flows that need to share a token. */
  public get apiClient(): ApiClient {
    return this.client;
  }
}
