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

    if (!dictData) {
        hide(resultsEl);
        errorEl.textContent = `No results found for "${word}".`;
        show(errorEl);
        return;
    }

    render(dictData, etymology, synonyms);
}

async function fetchDictionary(word) {
    try {
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(word)}`);
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

async function fetchEtymology(word) {
    try {
        const res = await fetch(
            `https://en.wiktionary.org/w/api.php?action=parse&page=${enc(word)}&prop=text&format=json&origin=*`
        );
        const data = await res.json();
        if (!data.parse) return null;

        const doc = new DOMParser().parseFromString(data.parse.text['*'], 'text/html');
        const heading = doc.querySelector('#Etymology, #Etymology_1');
        if (!heading) return null;

        let el = heading.closest('h2, h3, h4');
        if (!el) return null;

        let next = el.nextElementSibling;
        while (next) {
            if (/^H[234]$/.test(next.tagName)) break;
            if (next.tagName === 'P') return next.textContent.trim();
            next = next.nextElementSibling;
        }
        return null;
    } catch {
        return null;
    }
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

function render(entries, etymology, synonyms) {
    const entry = entries[0];

    const phonetic  = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';
    const audioUrl  = entry.phonetics?.find(p => p.audio)?.audio || '';

    let h = '';

    // Header
    h += `<div class="word-header">`;
    if (audioUrl) {
        h += `<button class="audio-btn" onclick="playAudio(${JSON.stringify(audioUrl)})" aria-label="Listen">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                </svg>
              </button>`;
    }
    h += `<span class="word-title">${esc(entry.word)}</span></div>`;

    if (phonetic) h += `<div class="phonetic">${esc(phonetic)}</div>`;

    // Meanings
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

    // Etymology
    if (etymology) {
        h += `<hr class="rule">
              <div class="section-label">Origin</div>
              <div class="etymology-text">${esc(etymology)}</div>`;
    }

    // Synonyms
    if (synonyms && synonyms.length > 0) {
        const chips = synonyms.map(s =>
            `<a class="synonym-chip"
                href="https://www.oxfordlearnersdictionaries.com/definition/english/${enc(s)}"
                target="_blank" rel="noopener noreferrer">${esc(s)}</a>`
        ).join('');
        h += `<hr class="rule">
              <div class="section-label">Synonyms</div>
              <div class="synonym-chips">${chips}</div>`;
    }

    resultsEl.innerHTML = h;
    show(resultsEl);
}

function playAudio(url) {
    new Audio(url).play().catch(() => {});
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function enc(s)   { return encodeURIComponent(s); }
function esc(s)   { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
