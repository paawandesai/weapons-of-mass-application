import type { TenantHandle } from '@wma/db';
import {
  getDriveClient,
  GoogleNotConnectedError,
  GoogleRevokedError,
  withGoogle,
} from '@wma/google';

export interface DriveFolder {
  id: string;
  name: string;
}

/** Thrown when Drive access is missing or revoked; the route turns it into 409 drive_not_connected. */
export class DriveNotConnectedError extends Error {
  readonly code = 'drive_not_connected' as const;
  constructor() {
    super('Google Drive is not connected');
    this.name = 'DriveNotConnectedError';
  }
}

export interface DriveFolderPort {
  listFolders(handle: TenantHandle, userId: string): Promise<DriveFolder[]>;
}

const MAX_FOLDERS = 500;

/** Lists the user's Drive folders (folders only) through the vaulted Google credentials. */
export const googleDriveFolders: DriveFolderPort = {
  async listFolders(handle, userId) {
    try {
      return await withGoogle(handle, userId, async () => {
        const drive = await getDriveClient(handle, userId);
        const folders: DriveFolder[] = [];
        let pageToken: string | undefined;
        do {
          const res = await drive.files.list({
            q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
            fields: 'nextPageToken, files(id, name)',
            orderBy: 'name',
            pageSize: 200,
            pageToken,
          });
          for (const f of res.data.files ?? []) {
            if (f.id && f.name) folders.push({ id: f.id, name: f.name });
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken && folders.length < MAX_FOLDERS);
        return folders;
      });
    } catch (e) {
      const status =
        (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status;
      if (
        e instanceof GoogleNotConnectedError ||
        e instanceof GoogleRevokedError ||
        status === 403
      ) {
        throw new DriveNotConnectedError();
      }
      throw e;
    }
  },
};
