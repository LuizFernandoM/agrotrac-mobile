import { openDatabaseAsync } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { Image } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import { photoLimits, type Photo, type Snapshot } from './domain';
import { Repository } from './repository';
import { imageDimensions } from './image';
import type { MobileSession } from './session';
export { apiUrl } from './http';

export async function openRepository() {
  const repo = new Repository(await openDatabaseAsync('agrotrac.db'));
  await repo.initialize();
  return repo;
}
export async function sha256(bytes: Uint8Array) {
  const result = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('');
}
export async function persistPhoto(asset: ImagePickerAsset, id: string): Promise<Photo> {
  const source = new File(asset.uri);
  if (source.size > 10485760) throw Error('Foto excede 10 MiB.');
  const bytes = await source.bytes();
  const { width, height } = imageDimensions(bytes);
  const mime_type = photoLimits(bytes, asset.mimeType, width, height);
  const decoded = await Image.getSize(asset.uri);
  // EXIF orientation may swap the decoder's displayed width and height.
  if (!(decoded.width === width && decoded.height === height || decoded.width === height && decoded.height === width)) throw Error('Dimensões da imagem divergentes.');
  const directory = new Directory(Paths.document, 'romaneios');
  await directory.create({ idempotent: true, intermediates: true });
  const destination = new File(directory, `${id}.${mime_type === 'image/png' ? 'png' : 'jpg'}`);
  if (destination.exists) throw Error('Arquivo de destino já existe; preservado.');
  await source.copy(destination, { overwrite: false });
  const saved = await destination.bytes(), hash = await sha256(bytes);
  if (saved.length !== bytes.length || await sha256(saved) !== hash) throw Error('Falha de integridade da cópia; arquivo preservado para suporte.');
  return Object.freeze({ uri: destination.uri, file_sha256: hash, file_size_bytes: saved.length, mime_type, width, height });
}
export function transport(auth: MobileSession, foreground: () => boolean, timeoutMs = 30000) {
  return async (s: Snapshot) => {
    const session = auth.current();
    if (!session || !foreground()) return null;
    const file = new File(s.photo.uri);
    if (!file.exists || file.size !== s.photo.file_size_bytes) throw Error('PHOTO_INTEGRITY_ERROR');
    const bytes = await file.bytes();
    if (bytes.length !== s.photo.file_size_bytes || await sha256(bytes) !== s.photo.file_sha256) throw Error('PHOTO_INTEGRITY_ERROR');
    const form = new FormData();
    form.append('weighing', JSON.stringify(s.payload));
    // Expo fetch consumes the File as a Blob and generates the multipart boundary.
    form.append('romaneio', file);
    return foreground() ? auth.upload(session, form, timeoutMs) : null;
  };
}
