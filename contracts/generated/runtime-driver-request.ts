/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface RuntimeRecipeDriverRequestV1 {
  schemaVersion: "1.0";
  method: "create" | "inspect";
  binding: {
    installationId: string;
    targetId: string;
    targetRevision: number;
    runId: string;
    workspaceId: string;
    operationId: string;
    requestDigest: string;
    workspaceOperationId: string;
    workspaceReceiptDigest: string;
    recipe: RecipePin;
    namespace: string;
    /**
     * @minItems 1
     * @maxItems 16
     */
    resources:
      | [
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ]
      | [
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          },
          {
            name: string;
            type: string;
          }
        ];
  };
  bindingDigest: string;
  workspace: {
    path: string;
    receipt: OwnedWorkspaceCreationReceiptV1;
  };
  configuration: {
    [k: string]: unknown;
  };
}
export interface RecipePin {
  id: string;
  version: string;
  digest: string;
}
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
