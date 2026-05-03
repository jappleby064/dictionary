const searchInput = document.getElementById('search-input');
const searchBtn   = document.getElementById('search-btn');
const clearBtn    = document.getElementById('clear-btn');
const resultsEl   = document.getElementById('results');
const errorEl     = document.getElementById('error');

searchBtn.addEventListener('click', search);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.add('hidden');
    searchInput.focus();
    hide(resultsEl);
    hide(errorEl);
});
searchInput.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', searchInput.value === '');
});

// Event delegation for synonym chips — avoids quote-escaping issues in onclick attrs
resultsEl.addEventListener('click', e => {
    const chip = e.target.closest('.synonym-chip');
    if (chip) searchWord(chip.dataset.word);
});

async function search() {
    const word = searchInput.value.trim();
    if (!word) return;

    resultsEl.innerHTML = '<div class="loading-msg">Looking up&hellip;</div>';
    show(resultsEl);
    hide(errorEl);

    const [dictData, etymology, synonyms] = await Promise.all([
        fetchDictionary(word),
        fetchEtymology(word),
        fetchSynonyms(word),
    ]);

    if (dictData) { render(dictData, etymology, synonyms); return; }

    const wikiData = await fetchWikipedia(word);
    if (wikiData) { renderWiki(wikiData, etymology, synonyms); return; }

    hide(resultsEl);
    errorEl.textContent = `No results found for "${word}".`;
    show(errorEl);
}

// ── API fetchers ──────────────────────────────────────────────────────────────

async function fetchDictionary(word) {
    try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(word)}`);
        if (!res.ok) return null;
        return res.json();
    } catch { return null; }
}

async function fetchWikipedia(word) {
    try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(word)}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.type === 'disambiguation') return null;
        return data;
    } catch { return null; }
}

// Returns { ancestors: [{lang,word}], cognates: [{lang,word}], raw } or null.
// Walks DOM text nodes to switch mode at "Cognate with". Ancestors are reversed oldest-first.
async function fetchEtymology(word) {
    try {
        const res = await fetch(
            `https://en.wiktionary.org/w/api.php?action=parse&page=${enc(word)}&prop=text&format=json&origin=*`
        );
        const data = await res.json();
        if (!data.parse) return null;

        const doc = new DOMParser().parseFromString(data.parse.text['*'], 'text/html');
        const heading = doc.querySelector('[id^="Etymology"]');
        if (!heading) return null;

        const el = heading.closest('.mw-heading') || heading.closest('h2,h3,h4');
        if (!el) return null;

        let next = el.nextElementSibling;
        while (next) {
            if (next.classList.contains('mw-heading') || /^H[2-4]$/.test(next.tagName)) break;
            if (next.tagName === 'P' && next.textContent.trim().length > 10) {
                return parseEtymParagraph(next);
            }
            next = next.nextElementSibling;
        }
        return null;
    } catch { return null; }
}

function parseEtymParagraph(pElem) {
    const ancestors = [];
    const cognates  = [];
    let mode        = 'ancestors';
    let pendingLang = null;

    function walk(node) {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                // Switch to cognates mode when we see the marker phrase
                if (/cognate\s+with|compare\s+with|akin\s+to/i.test(child.textContent)) {
                    mode = 'cognates';
                }
            } else if (child.nodeType === 1) {
                if (child.matches('span.etyl')) {
                    pendingLang = child.textContent.trim();
                } else if (child.matches('i.mention') && pendingLang) {
                    const word = (child.querySelector('a') || child).textContent.trim();
                    if (word) {
                        (mode === 'cognates' ? cognates : ancestors).push({ lang: pendingLang, word });
                        pendingLang = null;
                    }
                } else {
                    walk(child); // recurse into spans, links, etc.
                }
            }
        }
    }

    walk(pElem);

    return {
        ancestors: ancestors.reverse(), // oldest first
        cognates,
        raw: pElem.textContent.trim().replace(/\[\d+\]/g, ''),
    };
}

async function fetchSynonyms(word) {
    try {
        const res = await fetch(`https://api.datamuse.com/words?rel_syn=${enc(word)}&max=14`);
        const data = await res.json();
        return data.map(w => w.word);
    } catch { return []; }
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function render(entries, etymology, synonyms) {
    const entry    = entries[0];
    const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';

    let h = `<div class="word-header"><span class="word-title">${esc(entry.word)}</span></div>`;
    if (phonetic) h += `<div class="phonetic">${esc(phonetic)}</div>`;

    entry.meanings.forEach((meaning, i) => {
        if (i > 0) h += '<hr class="rule">';
        h += `<div class="pos-block">
                <div class="pos-label">${esc(meaning.partOfSpeech)}</div>
                <ul class="def-list">`;
        meaning.definitions.slice(0, 6).forEach(def => {
            h += `<li>
                    <div class="def-text">${esc(def.definition)}</div>
                    ${def.example ? `<div class="def-example">${esc(def.example)}</div>` : ''}
                  </li>`;
        });
        h += `</ul></div>`;
    });

    h += sharedSections(etymology, synonyms, entry.word);
    resultsEl.innerHTML = h;
    show(resultsEl);
}

function renderWiki(wiki, etymology, synonyms) {
    const pageUrl = wiki.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${enc(wiki.title)}`;
    let h = `<div class="word-header"><span class="word-title">${esc(wiki.title)}</span></div>
             <div class="wiki-source">
                 Source: Wikipedia
                 <a class="wiki-link" href="${pageUrl}" target="_blank" rel="noopener noreferrer">View on Wikipedia &#8599;</a>
             </div>
             <hr class="rule">
             <ul class="def-list">
                 <li><div class="def-text">${esc(wiki.extract)}</div></li>
             </ul>`;
    h += sharedSections(etymology, synonyms, wiki.title);
    resultsEl.innerHTML = h;
    show(resultsEl);
}

function sharedSections(etymology, synonyms, word) {
    let h = '';

    if (etymology) {
        h += `<hr class="rule"><div class="section-label">Origin</div>`;
        h += renderEtymTree(etymology, word);
    }

    if (synonyms && synonyms.length > 0) {
        const chips = synonyms.map(s =>
            `<button class="synonym-chip" data-word="${esc(s)}">${esc(s)}</button>`
        ).join('');
        h += `<hr class="rule">
              <div class="section-label">Synonyms</div>
              <div class="synonym-chips">${chips}</div>`;
    }

    return h;
}

// ── Etymology tree ────────────────────────────────────────────────────────────

function renderEtymTree(etym, word) {
    if (!etym) return '';
    const { ancestors, cognates, raw } = etym;

    if (ancestors.length === 0 && cognates.length === 0) {
        return `<div class="etymology-text">${esc(raw)}</div>`;
    }

    // Branching: oldest ancestor as root, then most-recent ancestor + cognates as siblings
    if (cognates.length > 0 && ancestors.length >= 1) {
        const root    = ancestors[0];                      // oldest (root)
        const lastAnc = ancestors[ancestors.length - 1];  // direct English ancestor
        const sibs    = [lastAnc, ...cognates.slice(0, 2)];

        let h = '<div class="etym-tree">';
        h += etymNodeH(root);
        h += etymArrowH();
        h += `<div class="etym-siblings-row">`;
        sibs.forEach(n => {
            h += `<div class="etym-sib-node">
                      <span class="etym-lang">${esc(n.lang.toUpperCase())}</span>
                      <span class="etym-word">${esc(n.word)}</span>
                  </div>`;
        });
        h += `</div>`;
        h += etymArrowH();
        h += `<div class="etym-final">${esc(word)}</div></div>`;
        return h;
    }

    // Linear chain
    let h = '<div class="etym-tree">';
    ancestors.forEach((n, i) => {
        h += etymNodeH(n);
        if (i < ancestors.length - 1) h += etymArrowH();
    });
    h += etymArrowH();
    h += `<div class="etym-final">${esc(word)}</div></div>`;
    return h;
}

function etymNodeH(n) {
    return `<div class="etym-node">
                <span class="etym-lang">${esc(n.lang.toUpperCase())}</span>
                <span class="etym-word">${esc(n.word)}</span>
            </div>`;
}

function etymArrowH() {
    return `<div class="etym-arrow"></div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function searchWord(word) {
    searchInput.value = word;
    clearBtn.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    search();
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function enc(s)   { return encodeURIComponent(s); }
function esc(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
