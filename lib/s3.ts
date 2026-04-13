import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not configured.`);
  }
  return v;
}

export function getS3Config() {
  return {
    region: requiredEnv("AWS_REGION"),
    bucket: requiredEnv("AWS_S3_BUCKET")
  };
}

export function createS3Client() {
  const { region } = getS3Config();
  return new S3Client({ region });
}

export function buildTaskPhotoKey(params: {
  dailyTaskId: number;
  kind: "before" | "after";
  ext: "jpg" | "jpeg" | "png";
  now?: Date;
}) {
  const ts = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return `tasks/${params.dailyTaskId}/${params.kind}/${ts}.${params.ext}`;
}

export function buildPublicUrl(key: string) {
  const { region, bucket } = getS3Config();
  const publicBaseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  const encodedKey = key
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return `${publicBaseUrl}/${encodedKey}`;
}

export async function uploadBufferToS3(params: { key: string; contentType: string; body: Buffer }) {
  const { bucket } = getS3Config();
  const client = createS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType
    })
  );

  return buildPublicUrl(params.key);
}

