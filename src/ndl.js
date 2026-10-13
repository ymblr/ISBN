const sleep = ms => new Promise(r => setTimeout(r, ms));
// NDLサーチ OpenSearch。1冊ずつ呼ぶ前提。429(同時アクセス制限)は待って再試行
export async function lookup(isbn) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch('https://ndlsearch.ndl.go.jp/api/opensearch?isbn=' + isbn);
    if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const it = new DOMParser().parseFromString(await res.text(), 'application/xml').querySelector('item');
    if (!it) return null;
    const t = tag => it.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    // NDC8/9/10のうち版が新しいものを採用
    const ndcs = [...it.getElementsByTagName('dc:subject')]
      .map(n => ({ v: +(/NDC(\d+)/.exec(n.getAttribute('xsi:type') || '')?.[1] || 0), s: n.textContent.trim() }))
      .filter(x => x.v).sort((a, b) => b.v - a.v);
    return {
      title: t('title'), author: t('author') || t('dc:creator'), publisher: t('dc:publisher'),
      ndc: ndcs[0]?.s || '', ndcVer: ndcs[0]?.v || 0, source: 'ndl',
    };
  }
  throw new Error('NDLが混雑中。少し待ってもう一度');
}
