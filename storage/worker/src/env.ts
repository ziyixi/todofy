import { ObjectMetadataSchema, ListObjectsResponseSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { fieldRules } from '@ziyixi/proto/wire-json';

export const STATE_NAME = 'storage-v1';
const objectLimit = fieldRules(ObjectMetadataSchema.field.sizeBytes).maximum;
if (objectLimit === undefined) throw new Error('Storage object size bound is missing.');
export const MAX_OBJECT_BYTES = objectLimit;
export const MAX_CLIENTS = 64;
export const MAX_PAGE_SIZE = fieldRules(ListObjectsResponseSchema.field.objects).maxItems;
export const DOMAIN = 'storage.ziyixi.science';

export interface Env {
  readonly STORAGE: DurableObjectNamespace;
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  readonly BUILD_SHA?: string;
  readonly DEV_AUTH_BYPASS?: string;
  /** Loopback fake only, enabled together with loopback owner authentication. */
  readonly DEV_DROPBOX_ORIGIN?: string;
}
