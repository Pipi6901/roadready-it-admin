'use client';

import { onSnapshot, orderBy, query } from 'firebase/firestore';
import React from 'react';

import { deleteMedia, mediaCollection, uploadMedia } from '@/lib/media';
import type { Media } from '@/lib/types';

interface MediaRow extends Media {
  id: string;
}

const LICENCES: Media['licence'][] = ['ministero-it', 'own'];

export default function MediaLibraryPage() {
  const [items, setItems] = React.useState<MediaRow[] | null>(null);
  const [licence, setLicence] = React.useState<Media['licence']>('own');
  const [filter, setFilter] = React.useState<Media['licence'] | 'all'>('all');
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const q = query(mediaCollection(), orderBy('filename'));
    return onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Media) })));
    });
  }, []);

  const onFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadMedia(file, licence);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onDelete = async (item: MediaRow) => {
    if (item.usedByQuestions.length > 0) {
      window.alert(
        `Can't delete — still attached to ${item.usedByQuestions.length} question(s). Detach it from those questions first.`,
      );
      return;
    }
    if (!window.confirm(`Delete "${item.filename}" permanently? This cannot be undone.`)) return;
    await deleteMedia(item.id, item.storagePath);
  };

  const visible = items?.filter((i) => filter === 'all' || i.licence === filter) ?? null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Media library</h1>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-black/10 p-4">
        <label className="text-sm">
          Licence for upload
          <select
            value={licence}
            onChange={(e) => setLicence(e.target.value as Media['licence'])}
            className="mt-1 block rounded-md border border-black/15 px-3 py-2"
          >
            {LICENCES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Files (image or video, up to 50 MB each)
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            disabled={uploading}
            onChange={(e) => void onFilesSelected(e.target.files)}
            className="mt-1 block text-sm"
          />
        </label>
        {uploading ? <span className="text-sm text-black/50">Uploading…</span> : null}
      </div>

      {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <div className="flex items-center gap-2 text-sm">
        <span className="text-black/50">Filter:</span>
        {(['all', ...LICENCES] as const).map((l) => (
          <button
            key={l}
            onClick={() => setFilter(l)}
            className={`rounded-md px-2 py-1 ${filter === l ? 'bg-black text-white' : 'hover:bg-black/5'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {visible === null ? (
        <div className="text-sm text-black/50">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-black/50">No media yet.</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((item) => (
            <div key={item.id} className="space-y-2 rounded-xl border border-black/10 p-3">
              {item.type === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.cdnUrl} alt={item.filename} className="h-32 w-full rounded-md object-cover" />
              ) : (
                <video src={item.cdnUrl} className="h-32 w-full rounded-md object-cover" controls />
              )}
              <div className="truncate text-sm font-medium" title={item.filename}>
                {item.filename}
              </div>
              <div className="text-xs text-black/50">
                {item.licence} · {item.width ? `${item.width}×${item.height}` : item.type}
                {item.usedByQuestions.length > 0 ? ` · used by ${item.usedByQuestions.length}` : ''}
              </div>
              <button onClick={() => void onDelete(item)} className="text-xs text-red-600 underline">
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
