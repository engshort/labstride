/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export type TrustedWorkspaceHelperResponseV2 = {
  schemaVersion: "2.0";
  requestId: string;
  installationId: string;
  targetId: string;
  targetRevision: number;
  method: "probe" | "create" | "inspect";
  outcome: "ok" | "error" | "outcome_unknown";
  /**
   * @maxItems 4
   */
  capabilities:
    | []
    | ["workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1"]
    | [
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1"
      ]
    | [
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1"
      ]
    | [
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1",
        "workspace.probe.v1" | "workspace.create.v1" | "workspace.inspect.v1" | "workspace.root-map.v1"
      ];
  error: Error | null;
  workspace: OwnedWorkspaceCreationReceiptV1 | null;
  roots?: Roots;
};
export type Error = {
  code:
    | "validation_failed"
    | "forbidden"
    | "unsupported_capability"
    | "authentication_failed"
    | "identity_mismatch"
    | "stale_revision"
    | "policy_changed"
    | "resource_busy"
    | "rate_limited"
    | "transient_unavailable"
    | "configuration_invalid"
    | "projection_conflict"
    | "operation_failed"
    | "cancelled"
    | "outcome_unknown";
  message: string;
  evidenceId: string | null;
  retryClass: "none" | "read_only" | "pre_effect_transient" | "reconcile";
};
/**
 * @minItems 1
 * @maxItems 16
 */
export type Roots =
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ]
  | [
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      },
      {
        id: string;
        path: string;
        identity: {
          device: number;
          inode: number;
          mountId: number;
          uid: number;
        };
      }
    ];

export interface OwnedWorkspaceCreationReceiptV1 {
  schemaVersion: "1.0";
  installationId: string;
  targetId: string;
  targetRevision: number;
  runId: string;
  workspaceId: string;
  operationId: string;
  requestDigest: string;
  rootId: string;
  locator: string;
  branch: string;
  ownershipRef: string;
  handle: string;
  source: {
    repositoryId: string;
    repository: string;
    sha: string;
    issue?: GithubIssue;
  };
  directoryIdentity: {
    device: number;
    inode: number;
    mountId: number;
    uid: number;
  };
  checkoutIdentity: {
    device: number;
    inode: number;
    mountId: number;
    uid: number;
  };
  state: "ready";
}
export interface GithubIssue {
  number: number;
  title: string;
}
