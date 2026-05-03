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

    if (dictData) {
        render(dictData, etymology, synonyms);
        return;
    }

    const wikiData = await fetchWikipedia(word);
    if (wikiData) {
        renderWiki(wikiData, etymology, synonyms);
        return;
    }

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
    } catch {
        return null;
    }
}

async function fetchWikipedia(word) {
    try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(word)}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.type === 'disambiguation') return null;
        return data;
    } catch {
        return null;
    }
}

// Returns { nodes: [{lang, word}], raw: string } or null.
// nodes are ordered oldest → newest (reversed from Wiktionary order).
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

        // Wiktionary wraps headings in <div class="mw-heading">; step up to that
        // so nextElementSibling reaches the <p> at the same document level.
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
    } catch {
        return null;
    }
}

function parseEtymParagraph(pElem) {
    const nodes = [];
    const etylSpans = pElem.querySelectorAll('span.etyl');

    etylSpans.forEach(span => {
        const lang = span.textContent.trim();
        // Walk forward from the etyl span to find the word form in an <i class="mention">
        let sib = span.nextSibling;
        while (sib) {
            if (sib.nodeType === 1) {
                if (sib.tagName === 'I' && sib.classList.contains('mention')) {
                    // Word may be in a nested <a>
                    const word = (sib.querySelector('a') || sib).textContent.trim();
                    if (word) { nodes.push({ lang, word }); break; }
                } else if (!['SPAN', 'A'].includes(sib.tagName)) {
                    break;
                }
            }
            sib = sib.nextSibling;
        }
    });

    const raw = pElem.textContent.trim().replace(/\[\d+\]/g, '');
    return { nodes: nodes.reverse(), raw };
}

async function fetchSynonyms(word) {
    try {
        const res = await fetch(`https://api.datamuse.com/words?rel_syn=${enc(word)}&max=14`);
        const data = await res.json();
        return data.map(w => w.word);
    } catch {
        return [];
    }
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
        const { nodes, raw } = etymology;
        h += `<hr class="rule"><div class="section-label">Origin</div>`;

        if (nodes && nodes.length >= 2) {
            h += `<div class="etym-tree">`;
            nodes.forEach((node, i) => {
                h += `<div class="etym-node">
                          <span class="etym-lang">${esc(node.lang.toUpperCase())}</span>
                          <span class="etym-word">${esc(node.word)}</span>
                      </div>`;
                if (i < nodes.length - 1) h += `<div class="etym-arrow"></div>`;
            });
            // Arrow into the searched word
            h += `<div class="etym-arrow"></div>
                  <div class="etym-final">${esc(word)}</div>`;
            h += `</div>`;
        } else {
            h += `<div class="etymology-text">${esc(raw)}</div>`;
        }
    }

    if (synonyms && synonyms.length > 0) {
        const chips = synonyms.map(s =>
            `<button class="synonym-chip" onclick="searchWord(${JSON.stringify(s)})">${esc(s)}</button>`
        ).join('');
        h += `<hr class="rule">
              <div class="section-label">Synonyms</div>
              <div class="synonym-chips">${chips}</div>`;
    }

    return h;
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
