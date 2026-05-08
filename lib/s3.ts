import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not configured.`);
  }
  return v;
}

function getS3CredentialsOrThrow():
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | null {
  const allowDefaultChain = (process.env.AWS_ALLOW_DEFAULT_CREDENTIALS_CHAIN ?? "").toLowerCase() === "true";
  if (allowDefaultChain) return null;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS credentials are not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if applicable), or set AWS_ALLOW_DEFAULT_CREDENTIALS_CHAIN=true to use the AWS SDK default credential chain."
    );
  }

  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

export function getS3Config() {
  return {
    region: requiredEnv("AWS_REGION"),
    bucket: requiredEnv("AWS_S3_BUCKET")
  };
}

export function createS3Client() {
  const { region } = getS3Config();
  const credentials = getS3CredentialsOrThrow();
  const requestHandler = new NodeHttpHandler({ connectionTimeout: 55000, socketTimeout: 90000 });
  return credentials
    ? new S3Client({ region, credentials, requestHandler })
    : new S3Client({ region, requestHandler });
}

let _s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3Client) _s3Client = createS3Client();
  return _s3Client;
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

export function buildAttendanceSelfieKey(params: {
  staffId: number;
  workDate: Date;
  ext: "jpg" | "png";
  now?: Date;
}) {
  const day = params.workDate.toISOString().slice(0, 10);
  const ts = (params.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  return `attendance/${params.staffId}/${day}/selfie-${ts}.${params.ext}`;
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
  const client = getS3Client();

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

