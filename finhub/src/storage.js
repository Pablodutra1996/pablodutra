/**
 * Armazenamento de arquivos (evidências, anexos do chat e backups).
 *  - local: pasta DATA_DIR/uploads (desenvolvimento ou servidor com disco persistente)
 *  - s3:    AWS S3 ou compatível (Cloudflare R2, Backblaze B2, Wasabi, MinIO...)
 *  - azure: Azure Blob Storage (natural para quem já usa Microsoft 365)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';

const { driver } = config.storage;

function localDriver() {
  const root = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(root, { recursive: true });
  const resolve = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root)) throw new Error('Chave de arquivo inválida');
    return p;
  };
  return {
    name: 'local',
    async put(key, buffer) {
      const p = resolve(key);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, buffer);
    },
    async getStream(key) {
      return fs.createReadStream(resolve(key));
    },
    async remove(key) {
      await fs.promises.rm(resolve(key), { force: true });
    },
  };
}

async function s3Driver() {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const c = config.storage.s3;
  if (!c.bucket) throw new Error('S3_BUCKET não configurado');
  const client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: c.accessKeyId ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } : undefined,
  });
  return {
    name: 's3',
    async put(key, buffer, mime) {
      await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: buffer, ContentType: mime }));
    },
    async getStream(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
      return out.Body instanceof Readable ? out.Body : Readable.fromWeb(out.Body);
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
  };
}

async function azureDriver() {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const c = config.storage.azure;
  if (!c.connectionString) throw new Error('AZURE_STORAGE_CONNECTION_STRING não configurado');
  const container = BlobServiceClient.fromConnectionString(c.connectionString).getContainerClient(c.container);
  await container.createIfNotExists();
  return {
    name: 'azure',
    async put(key, buffer, mime) {
      await container.getBlockBlobClient(key).uploadData(buffer, { blobHTTPHeaders: { blobContentType: mime } });
    },
    async getStream(key) {
      const res = await container.getBlobClient(key).download();
      return res.readableStreamBody;
    },
    async remove(key) {
      await container.getBlobClient(key).deleteIfExists();
    },
  };
}

let instance;
export async function getStorage() {
  if (!instance) {
    instance = driver === 's3' ? await s3Driver() : driver === 'azure' ? await azureDriver() : localDriver();
    console.log(`[storage] driver: ${instance.name}`);
  }
  return instance;
}

export function safeFilename(name) {
  return String(name || 'arquivo')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .slice(-120);
}
