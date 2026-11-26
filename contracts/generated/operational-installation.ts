/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type Condition =
  | {
      field: string;
      op: "equals" | "notEquals" | "contains" | "changedTo";
      value: FieldValue;
    }
  | {
      field: string;
      op: "exists";
    }
  | {
      /**
       * @minItems 1
       */
      all: [Condition, ...Condition[]];
    }
  | {
      /**
       * @minItems 1
       */
      any: [Condition, ...Condition[]];
    }
  | {
      not: Condition;
    };
/**
 * @maxItems 1024
 */
export type FieldValue = string | number | boolean | null | string[];
export type InputBinding =
  | (string | number | boolean | null)
  | InputBinding[]
  | {
      [k: string]: InputBinding;
    }
  | {
      binding: "field";
      field: string;
      mapping?: {
        [k: string]: string;
      };
    }
  | {
      binding: "context";
      context: "source" | "mergeSha" | "workspaceId";
    }
  | {
      binding: "literal";
      value: JsonValue;
    };
export type JsonValue =
  | {
      [k: string]: JsonValue;
    }
  | JsonValue[]
  | string
  | number
  | boolean
  | null;

export interface OperationalInstallationV1 {
  schemaVersion: "1.0";
  configuration: LabstrideInstallationConfigurationV1;
  lock: ExtensionLock;
  policy: AuthorizationPolicy;
  /**
   * @maxItems 16
   */
  historyQualifications:
    | []
    | [GitHubHistoryQualification]
    | [GitHubHistoryQualification, GitHubHistoryQualification]
    | [GitHubHistoryQualification, GitHubHistoryQualification, GitHubHistoryQualification]
    | [GitHubHistoryQualification, GitHubHistoryQualification, GitHubHistoryQualification, GitHubHistoryQualification]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ]
    | [
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification,
        GitHubHistoryQualification
      ];
  stateDirectory: string;
  sourceRoot: string;
  rootId: string;
  targetId: string;
  revision: string;
  credentials: {
    [k: string]:
      | string
      | {
          kind: "github-app";
          appId: string;
          installationId: number;
          keyFile: string;
          /**
           * @minItems 1
           */
          repositoryIds: [number, ...number[]];
          permissions: {
            [k: string]: "read" | "write";
          };
        };
  };
  host: {
    protocol: {
      major: 1;
      minor: number;
    };
    capabilities: string[];
    permissions: string[];
  };
  agent: {
    bridgeSocket: string;
    backendIdentity: string;
    backendVersion: string;
    existingCheckout?: string;
    checkedDelivery: true;
    defaults: {
      aiMode: string;
      model: string;
      reasoning: string;
    };
    runtimeValues: {
      aiMode: {
        [k: string]: string;
      };
      model: {
        [k: string]: string;
      };
      reasoning: {
        [k: string]: string;
      };
    };
  };
  baseBranch: string;
  /**
   * @minItems 1
   */
  requiredWorkflows: [string, ...string[]];
  rootMappingFile: string;
  brokerListener?: {
    port: number;
  };
  mergeEnabled?: boolean;
}
export interface LabstrideInstallationConfigurationV1 {
  schemaVersion: "1.0";
  installationId: string;
  enabled: boolean;
  broker:
    | {
        enabled: false;
      }
    | {
        url: string;
        oidcAudience: string;
        enabled?: true;
      };
  github: {
    /**
     * @minItems 1
     */
    repositories: [string, ...string[]];
    /**
     * @minItems 1
     */
    actorIds: [string, ...string[]];
    credentialRef: string;
    projectCredentialRef: string;
    pollIntervalSeconds: number;
  };
  fields: {
    [k: string]: {
      source: "project_v2" | "organization_issue_field" | "native_issue" | "label" | "issue_form";
      scopeId: string;
      fieldId: string;
      type: "string" | "boolean" | "number" | "date" | "single-select" | "multi-select";
      options?: {
        [k: string]: string;
      };
      /**
       * Opt in to disjoint managed progress values on a single-select request field; controls remain human-owned.
       */
      allowManagedProgress?: boolean;
    };
  };
  targets: {
    [k: string]: {
      connector: string;
      configuration: {
        [k: string]: unknown;
      };
    };
  };
  /**
   * @minItems 1
   */
  extensions: [
    {
      id: string;
      version: string;
      integrity: string;
    },
    ...{
      id: string;
      version: string;
      integrity: string;
    }[]
  ];
  limits: {
    activeRuns: number;
    perIssue: 1;
    perDeploymentTarget: 1;
    metadataRetentionDays: number;
    development?: number;
    ciReview?: number;
    maxRepairs?: number;
    unattendedMs?: number;
  };
  /**
   * @minItems 1
   */
  rules: [
    {
      id: string;
      event: string;
      condition: Condition;
      workflow: string;
    },
    ...{
      id: string;
      event: string;
      condition: Condition;
      workflow: string;
    }[]
  ];
  workflows: {
    /**
     * @minItems 1
     */
    [k: string]: [
      {
        id: string;
        action: string;
        inputs: {
          [k: string]: InputBinding;
        };
      },
      ...{
        id: string;
        action: string;
        inputs: {
          [k: string]: InputBinding;
        };
      }[]
    ];
  };
  /**
   * @minItems 0
   */
  projections: ({
    [k: string]: unknown;
  } & {
    fact: string;
    field: string;
    value?: FieldValue;
    valueFrom?:
      | {
          kind: "workspace-source-path";
          targetId: string;
          rootId: string;
          rootPath: string;
        }
      | {
          kind: "session-id";
        };
  })[];
  extensionConfiguration: {
    [k: string]: {
      [k: string]: unknown;
    };
  };
  controls: {
    [k: string]: {
      field: string;
      /**
       * @minItems 1
       */
      enabledValues: [FieldValue, ...FieldValue[]];
      /**
       * @minItems 1
       */
      disabledValues: [FieldValue, ...FieldValue[]];
    };
  };
  cleanup?: CleanupPolicyV1;
}
export interface CleanupPolicyV1 {
  schemaVersion: "1.0";
  trigger: "completion_verified" | "operator_request";
  actionId: string;
  actionVersion: string;
  completion: "merge_and_deployment" | "merge_only";
  /**
   * @maxItems 128
   */
  regenerableIgnoredPaths: string[];
}
export interface ExtensionLock {
  schemaVersion: "1.0";
  /**
   * @minItems 1
   * @maxItems 128
   */
  extensions: [InstalledExtensionPin, ...InstalledExtensionPin[]];
}
export interface InstalledExtensionPin {
  id: string;
  version: string;
  kind: "provider" | "connector" | "action" | "session-provider";
  integrity: string;
  artifactPath: string;
  configuration: {
    [k: string]: unknown;
  };
  /**
   * @maxItems 128
   */
  permissions: string[];
  /**
   * @maxItems 128
   */
  capabilities: string[];
}
export interface AuthorizationPolicy {
  schemaVersion: "1.0";
  installationId: string;
  /**
   * @maxItems 256
   */
  actorIds: string[];
  /**
   * @maxItems 256
   */
  repositories: {
    id: string;
    name: string;
  }[];
  /**
   * @maxItems 256
   */
  grants: {
    repositoryId: string;
    targetId: string;
    actionId: string;
    actionVersion: string;
    /**
     * @minItems 1
     * @maxItems 256
     */
    effects: ["execute" | "cancel", ...("execute" | "cancel")[]];
  }[];
}
export interface GitHubHistoryQualification {
  schemaVersion: "1.0";
  scopeId: string;
  fieldId: string;
  subjectId: string;
  eventId: string;
  actorId: string;
  optionId: string;
  status: string;
}
