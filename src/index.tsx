import { v4 as uuid } from 'uuid';
import hash from 'object-hash';

/**
 * Constructor arguments for EventLogger.
 */
export interface EventLoggerProps {
  /**
   * The name of your Platform in Promoted's configuration.
   */
  platformName: string;

  /*
  Indicates how to handle errors.
  E.g. in development, throw an error so the developer can see.  In production,
  you might want to silently log and monitor to minimize the impact to the UI
  if there is an issue.

  Here is example code for NextJS:
  ```
  const throwError =
    process?.env?.NODE_ENV !== 'production' ||
    (typeof location !== "undefined" && location?.hostname === "localhost");
  ...
  handleLogError: throwError ? (err) => {
      throw error;
    } : (err) => console.error(err);
  }
  ```
  */
  handleLogError: (err: Error) => void;

  /**
   * Used to override `window.snowplow` for testing.
   */
  snowplow?: (...args: any[]) => void;

  /**
   * Used to override LocalStorage for testing.
   */
  localStorage?: LocalStorage;

  /**
   * Key for local storage that contains the last logged session ID.
   * We want to log the User object at least once per session.
   * By default, 'p-us' is used.
   */
  userSessionLocalStorageKey?: string;

  /**
   * Key for local storage that contains the hash of the last logged user.
   * We want to log the User object when the user object changes.
   * By default, 'p-uh' is used.
   */
  userHashLocalStorageKey?: string;
}

export interface User {
  common: {};
}

export interface CommonRequest {
  // viewId gets filled in on the server.
  requestId: string;
}

export interface Request {
  common: CommonRequest;
}

export interface CommonInsertion {
  // TODO - specify requestId.
  insertionId: string;
}

export interface Insertion {
  common: CommonInsertion;
}

export interface CommonImpression {
  // TODO - specify insertion.
  impressionId: string;
}

export interface Impression {
  common: CommonImpression;
}

export interface Click {
  /**
   * The impressionId for the content (if content was clicked on).
   */
  impressionId?: string;
  /**
   * The target URL.  For actions on the same page, you can use '#action'.
   */
  targetUrl: string;
  /**
   * The target URL.  For actions on the same page, you can use '#action'.
   */
  elementId: string;
}

// Store the last domain userId we saved to Promoted to reduce the number of
// log calls.
const DEFAULT_USER_SESSION_LOCAL_STORAGE_KEY = 'p-us';
const DEFAULT_USER_HASH_LOCAL_STORAGE_KEY = 'p-uh';

export interface LocalStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Returns the contexts for clicks given the parameters.
 */
const getClickContexts = (impressionId: string | undefined) => {
  if (impressionId) {
    return [
      {
        schema: 'iglu:ai.promoted/impression_cx/jsonschema/1-0-0',
        data: {
          impressionId,
        },
      },
    ];
  } else {
    return undefined;
  }
};

/**
 * A utility class for logging events.
 *
 * Warning: This class modifies the inputs.  We avoid creating duplicate objects
 * to reduce memory pressure.
 */
export class EventLogger {
  private platformName: string;
  // Delay generation until needed since not all pages log all types of schemas.
  private userIgluSchema?: string;
  private requestIgluSchema?: string;
  private insertionIgluSchema?: string;
  private impressionIgluSchema?: string;

  private handleLogError: (err: Error) => void;
  private snowplow: (...args: any[]) => void;
  private localStorage?: LocalStorage;
  userSessionLocalStorageKey: string;
  private userHashLocalStorageKey: string;

  /**
   * @params {EventLoggerProps} props The arguments for the logger.
   */
  public constructor(props: EventLoggerProps) {
    this.platformName = props.platformName;
    this.handleLogError = props.handleLogError;
    // @ts-expect-error window does not have snowplow on it.
    this.snowplow = props.snowplow || window?.snowplow;
    this.localStorage = props.localStorage;
    if (this.localStorage === undefined) {
      this.localStorage = window && window?.localStorage;
    }
    this.userSessionLocalStorageKey =
      props.userSessionLocalStorageKey !== undefined
        ? props.userSessionLocalStorageKey
        : DEFAULT_USER_SESSION_LOCAL_STORAGE_KEY;
    this.userHashLocalStorageKey =
      props.userHashLocalStorageKey !== undefined ? props.userHashLocalStorageKey : DEFAULT_USER_HASH_LOCAL_STORAGE_KEY;
  }

  /**
   * Returns the User IGLU Schema URL.  As a function to delay string construction.
   */
  private getUserIgluSchema2() {
    if (!this.userIgluSchema) {
      this.userIgluSchema = `iglu:ai.promoted.${this.platformName}/user/jsonschema/1-0-0`;
    }
    return this.userIgluSchema;
  }

  /**
   * Returns the Request IGLU Schema URL.  As a function to delay string construction.
   */
  private getRequestIgluSchema() {
    if (!this.requestIgluSchema) {
      this.requestIgluSchema = `iglu:ai.promoted.${this.platformName}/request/jsonschema/1-0-0`;
    }
    return this.requestIgluSchema;
  }

  /**
   * Returns the Insertion IGLU Schema URL.  As a function to delay string construction.
   */
  private getInsertionIgluSchema() {
    if (!this.insertionIgluSchema) {
      this.insertionIgluSchema = `iglu:ai.promoted.${this.platformName}/insertion/jsonschema/1-0-0`;
    }
    return this.insertionIgluSchema;
  }

  /**
   * Returns the Impression IGLU Schema URL.  As a function to delay string construction.
   */
  private getImpressionIgluSchema() {
    if (!this.impressionIgluSchema) {
      this.impressionIgluSchema = `iglu:ai.promoted.${this.platformName}/impression/jsonschema/1-0-0`;
    }
    return this.impressionIgluSchema;
  }

  // TODO - also re-log if the user (or hash of the) object changes.
  /**
   * Logs the user data depending on the configuration.  The default
   * configuration is log once per session.
   * Warning: the call will modify the user data.  Clients must copy the object.
   * @param {User} the call will modify the object
   */
  maybeLogUser(user: User) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    // This version of the snowplow method allows us to get access to `cf`.
    this.snowplow(function () {
      // We use cf to get sessionId.
      // @ts-expect-error Snowplow docs recommend this calling pattern.
      self.innerLogUser(this.cf, user);
    });
  }

  innerLogUser(cf: any, user: User) {
    const schema = this.getUserIgluSchema2();
    try {
      const domainUserInfo = cf.getDomainUserInfo();
      const sessionId = domainUserInfo[6];
      // If localStorage is not enabled, this will log a bunch of duplicate user records.
      const oldSessionId = this.localStorage?.getItem(this.userSessionLocalStorageKey);
      const oldUserHash = this.localStorage?.getItem(this.userHashLocalStorageKey);
      // Only send the log events if the userId changes.
      const newUserHash = hash(user);
      if (sessionId !== oldSessionId || newUserHash !== oldUserHash) {
        this.snowplow('trackUnstructEvent', {
          schema,
          data: user,
        });
        this.localStorage?.setItem(this.userSessionLocalStorageKey, sessionId);
        this.localStorage?.setItem(this.userHashLocalStorageKey, newUserHash);
      }
    } catch (error) {
      this.handleLogError(error);
    }
  }

  /**
   * Logs the Request object.  Modifies Request to include common.requestId.
   */
  logRequest(request: Request) {
    try {
      // Q - should I add viewId here on the server?
      this.snowplow('trackUnstructEvent', {
        schema: this.getRequestIgluSchema(),
        data: request,
      });
    } catch (error) {
      this.handleLogError(error);
    }
  }

  /**
   * Returns a new UUID.
   */
  createInsertionId() {
    return uuid();
  }

  /**
   * Logs the Insertion object.
   */
  logInsertion(insertion: Insertion) {
    try {
      this.snowplow('trackUnstructEvent', {
        schema: this.getInsertionIgluSchema(),
        data: insertion,
      });
    } catch (error) {
      this.handleLogError(error);
    }
  }

  /**
   * Logs the Impression object.
   */
  logImpression(impression: Impression) {
    try {
      this.snowplow('trackUnstructEvent', {
        schema: this.getImpressionIgluSchema(),
        data: impression,
      });
    } catch (error) {
      this.handleLogError(error);
    }
  }

  logClick({ impressionId, targetUrl, elementId }: Click) {
    try {
      this.snowplow('trackLinkClick', targetUrl, elementId, [], '', '', getClickContexts(impressionId));
    } catch (error) {
      this.handleLogError(error);
    }
  }
}
