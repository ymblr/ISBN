const sleep = ms => new Promise(r => setTimeout(r, ms));

// Google Books: NDLに無い本(新刊・同人・小規模出版など)の書誌と表紙の補完用。失敗したらnull
async function googleBook(isbn) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1&fields=items(volumeInfo(title,subtitle,authors,publisher,imageLinks))`);
    const v = (await r.json()).items?.[0]?.volumeInfo;
    if (!v) return null;
    const u = v.imageLinks?.thumbnail;
    return {
      title: [v.title, v.subtitle].filter(Boolean).join(' '), volume: '', author: (v.authors || []).join(', '), authorKana: '',
      publisher: v.publisher || '', ndc: '', source: 'google', cover: u ? u.replace('http://', 'https://').replace('&edge=curl', '') : '',
    };
  } catch { return null; }
}

// NDLサーチ OpenSearch(1冊ずつ呼ぶ前提)。NDLに無ければGoogle Booksで補う。どちらにも無ければnull
export async function lookup(isbn) {
  let res;
  for (let i = 0; i < 4; i++) {
    try { res = await fetch('https://ndlsearch.ndl.go.jp/api/opensearch?isbn=' + isbn); }
    catch { throw new Error('NDLに接続できなかった。通信状況を確認してもう一度'); }
    if (res.status !== 429) break;
    await sleep(1500 * (i + 1));
  }
  if (res.status === 429) throw new Error('NDLが混雑中。少し待ってもう一度');
  if (!res.ok) throw new Error('NDLがエラーを返した(HTTP ' + res.status + ')');
  const it = new DOMParser().parseFromString(await res.text(), 'application/xml').querySelector('item');
  if (!it) return googleBook(isbn);
  const t = tag => it.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
  const volume = [t('dcndl:volume') || /巻次[:：]\s*([^<\n]+)/.exec(t('description'))?.[1]?.trim(), t('dcndl:volumeTitle')].filter(Boolean).join(' ');
  const ndcs = [...it.getElementsByTagName('dc:subject')]
    .map(n => ({ v: +(/NDC(\d+)/.exec(n.getAttribute('xsi:type') || '')?.[1] || 0), s: n.textContent.trim() }))
    .filter(x => x.v).sort((a, b) => b.v - a.v);
  return {
    title: t('title'), volume, author: t('author') || t('dc:creator'),
    authorKana: t('dcndl:creatorTranscription').replace(/[,、]?\s*\d{4}.*$/, ''),
    publisher: t('dc:publisher'), ndc: ndcs[0]?.s || '', source: 'ndl', cover: (await googleBook(isbn))?.cover || '',
  };
}
