// Keep credentials in the request header. Filenames never come from HTML or URLs.
export async function downloadEventPdf(
  id: string | number, apiFetch: (url: string) => Promise<Response>,
) {
  if (!/^\d+$/.test(String(id))) throw Error('Save the event before downloading its document.');
  return downloadPrivatePdf(`/api/conferences/${id}/download-pdf/`, `Conference_${id}.pdf`, apiFetch);
}

export async function downloadPrivatePdf(
  path: string, filename: string, apiFetch: (url: string) => Promise<Response>,
) {
  const token = localStorage.getItem('token');
  if (!token) throw Error('Sign in to download this document.');
  const response = await apiFetch(path);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.detail || 'Document download failed. Check your login and event assignment.');
  }
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/pdf')) throw Error('The server did not return a PDF.');
  const blob = await response.blob();
  if (token !== localStorage.getItem('token')) throw Error('Account changed during download. Try again.');
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // iOS may consume the URL after the click handler returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
