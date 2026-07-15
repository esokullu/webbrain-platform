import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export function createSpacesObjectStore(config, { client } = {}) {
  if (!config?.enabled) return null;
  const s3 = client || new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
  const bucket = config.bucket;

  return {
    async list(prefix) {
      const objects = [];
      let continuationToken;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const item of page.Contents || []) {
          objects.push({
            key: item.Key,
            size: Number(item.Size || 0),
            etag: String(item.ETag || '').replace(/^"|"$/g, ''),
            modifiedAt: item.LastModified || null,
          });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },

    async head(key) {
      try {
        const item = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          key,
          size: Number(item.ContentLength || 0),
          contentType: item.ContentType || 'application/octet-stream',
          etag: String(item.ETag || '').replace(/^"|"$/g, ''),
          modifiedAt: item.LastModified || null,
        };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error?.name)) return null;
        throw error;
      }
    },

    async get(key, range = null) {
      const item = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }));
      return {
        body: item.Body,
        size: Number(item.ContentLength || 0),
        contentRange: item.ContentRange || null,
      };
    },

    async put(key, body, { contentLength = null, contentType = 'application/octet-stream' } = {}) {
      const upload = new Upload({
        client: s3,
        params: {
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: contentLength == null ? undefined : Number(contentLength),
          ContentType: contentType,
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      const result = await upload.done();
      return {
        etag: String(result.ETag || '').replace(/^"|"$/g, ''),
        location: result.Location || null,
      };
    },

    close() {
      s3.destroy?.();
    },
  };
}
