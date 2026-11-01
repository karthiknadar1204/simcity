import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

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
  const hash = (body: string) =>
    new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return {
    async put(key: string, body: string) {
      const checksum = hash(body);
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          Body: body,
          ContentType: "application/json",
          Metadata: { sha256: checksum },
        }),
      );
      const readback = await client.send(
        new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
      );
      const actual = await readback.Body?.transformToString();
      if (actual === undefined || hash(actual) !== checksum)
        throw new Error("Archive checksum mismatch.");
      return { key, checksum, bytes: Buffer.byteLength(body) };
    },
    close() {
      client.destroy();
    },
  };
}
