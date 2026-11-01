import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
export function createArchiveStore() {
  const {
    R2_ACCOUNT_ID,
    R2_BUCKET_NAME,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
  } = process.env;
  if (
    !R2_ACCOUNT_ID ||
    !R2_BUCKET_NAME ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY
  )
    return null;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  });
  const hash = (body: Uint8Array) =>
    new Bun.CryptoHasher("sha256").update(body).digest("hex");
  async function read(key: string, checksum?: string, expectedBytes?: number) {
    const result = await client.send(
      new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (
      !bytes ||
      (checksum && hash(bytes) !== checksum) ||
      (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)
    )
      throw new Error("Archive checksum or size mismatch.");
    return bytes;
  }
  async function putBytes(key: string, body: Uint8Array, contentType: string) {
    const checksum = hash(body);
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: checksum },
      }),
    );
    await read(key, checksum, body.byteLength);
    return { key, checksum, bytes: body.byteLength };
  }
  return {
    read,
    putBytes,
    put: (key: string, body: string) =>
      putBytes(key, new TextEncoder().encode(body), "application/json"),
    signGet: (key: string) =>
      getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
        { expiresIn: 300 },
      ),
    close: () => client.destroy(),
  };
}
export type ArchiveStore = NonNullable<ReturnType<typeof createArchiveStore>>;
