// src/utils/r2.js
//
// Private object storage on Cloudflare R2 (S3-compatible). Used for KYC
// documents. The bucket must stay PRIVATE - files are only ever reachable
// through short-lived signed URLs generated for an authenticated admin.
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;

function config() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error('storage_not_configured');
  }
  return { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET };
}

function getClient() {
  const c = config();
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: c.R2_ACCESS_KEY_ID, secretAccessKey: c.R2_SECRET_ACCESS_KEY },
    });
  }
  return { s3: client, bucket: c.R2_BUCKET };
}

async function putPrivateObject({ key, body, contentType }) {
  const { s3, bucket } = getClient();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function deleteObject(key) {
  const { s3, bucket } = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Short-lived read link. `filename` only affects the download/display name.
async function signedGetUrl(key, { expiresIn = 300, filename } = {}) {
  const { s3, bucket } = getClient();
  const safe = String(filename || 'document').replace(/[^\w.\- ]/g, '_').slice(0, 100);
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: `inline; filename="${safe}"`,
    }),
    { expiresIn }
  );
}

module.exports = { putPrivateObject, deleteObject, signedGetUrl };
