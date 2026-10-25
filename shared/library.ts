/** Studio organization only: folders do not move files or publish to Civitai. */
export type LibraryFolder = { id: string; name: string; createdAt: string; updatedAt: string; outputIds: string[] }
export type LibraryState = { revision: string; folders: LibraryFolder[] }
export const libraryLimits = { folders: 40, name: 80, memberships: 10000, moveBatch: 200 } as const
