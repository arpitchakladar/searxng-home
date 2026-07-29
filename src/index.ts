interface SearXInstance {
  http?: { grade?: string; score?: number };
  uptime?: {
    uptimeDay?: number;
    uptimeWeek?: number;
    uptimeMonth?: number;
    uptimeYear?: number;
  };
  network?: { dnssec?: number };
}

interface SearXResponse {
  instances: Record<string, SearXInstance>;
}

class SearXHomeManager {
  private selectElement: HTMLSelectElement | null;
  private inputElement: HTMLInputElement | null;
  private suggestionsElement: HTMLUListElement | null;
  private readonly CACHE_KEY = 'searx_selected_instance';
  private readonly FALLBACK_URL = 'https://search.ononoki.org';
  private isLoadingSuggestions = false;

  // Autocomplete state.
  // highlightedIndex: -1 means the input itself is focused;
  // 0..length-1 means that <li> currently has DOM focus.
  private debounceTimer: number | undefined;
  private abortController: AbortController | null = null;
  private currentSuggestions: string[] = [];
  private highlightedIndex = -1;
  private readonly DEBOUNCE_MS = 200;
  private readonly MAX_SUGGESTIONS = 10;

  // Engines queried in parallel for autocomplete suggestions.
  // Results are merged + de-duplicated. Order here = priority order
  // when the same suggestion comes back from multiple engines.
  private readonly AUTOCOMPLETE_PROVIDERS: string[] = [
    'google',
    'duckduckgo',
    'brave',
    'startpage',
    'wikipedia',
    'swisscows',
  ];

  // Define your persistent global preferences here
  private readonly userPreferences: Record<string, string> = {
    language: 'en', // e.g., English language
    safesearch: '1', // 0: None, 1: Moderate, 2: Strict
    categories: 'general', // Default category (general, science, IT, etc.)
    engines: 'google',
    autocomplete: 'google',
    simple_style: 'black',
  };

  constructor() {
    this.selectElement = document.getElementById('instance-select') as HTMLSelectElement;
    this.inputElement = document.getElementById('search-input') as HTMLInputElement;
    this.suggestionsElement = document.getElementById('suggestions-list') as HTMLUListElement;
    this.initSearch();
    this.initAutocomplete();
    this.fetchInstances();
    this.autofocusInput();
  }

  // localStorage can throw (Safari private mode, disabled storage, etc.)
  // so every access goes through these helpers.
  private getSavedInstance(): string | null {
    try {
      return localStorage.getItem(this.CACHE_KEY);
    } catch {
      return null;
    }
  }

  private saveInstance(url: string): void {
    try {
      localStorage.setItem(this.CACHE_KEY, url);
    } catch {
      // storage unavailable — selection just won't persist across reloads
    }
  }

  private autofocusInput(): void {
    if (this.inputElement) {
      this.inputElement.focus();

      // Handle scenarios where browser focus shifts late during load
      window.addEventListener('load', () => {
        this.inputElement?.focus();
      });
    }
  }

  private async fetchInstances(): Promise<void> {
    try {
      const response = await fetch('https://searx.space/data/instances.json');
      const data: SearXResponse = await response.json();

      if (!this.selectElement) return;
      this.selectElement.innerHTML = '';

      const validInstances = Object.entries(data.instances)
        .filter(([url]) => url.startsWith('https://'))
        .map(([url, info]) => ({
          url,
          info,
          score: this.calculateReliabilityScore(info),
        }))
        .sort((a, b) => b.score - a.score);

      if (validInstances.length === 0) {
        throw new Error('No instances found');
      }

      const savedInstance = this.getSavedInstance();
      const savedInstanceExists = validInstances.some(({ url }) => url === savedInstance);

      validInstances.forEach(({ url, info, score }) => {
        const hostname = new URL(url).hostname;
        const option = document.createElement('option');
        option.value = url;

        const gradeStr = info.http?.grade ? ` [${info.http.grade}]` : '';
        const uptimeVal = info.uptime?.uptimeMonth ?? info.uptime?.uptimeDay ?? 0;
        const uptimeStr = uptimeVal ? ` [${uptimeVal}%]` : '';

        option.textContent = `${hostname}${gradeStr}${uptimeStr} (Score: ${score})`;

        this.selectElement?.appendChild(option);
      });

      // Decide what should actually be selected: the previously saved
      // instance if it's still in the list, otherwise the top-ranked one.
      const instanceToSelect = savedInstanceExists
        ? (savedInstance as string)
        : validInstances[0].url;
      this.selectElement.value = instanceToSelect;

      // Keep localStorage in sync even if we had to fall back
      // (no saved value yet, or the saved one disappeared from the list).
      if (!savedInstanceExists) {
        this.saveInstance(instanceToSelect);
      }

      this.selectElement.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        if (target?.value) {
          this.saveInstance(target.value);
        }
      });
    } catch (error) {
      console.error('Failed to load instances from searx.space:', error);
      if (this.selectElement) {
        const saved = this.getSavedInstance();
        const fallbackUrl = saved ?? this.FALLBACK_URL;
        const hostname = new URL(fallbackUrl).hostname;
        this.selectElement.innerHTML = `<option value="${fallbackUrl}">${hostname} (Fallback)</option>`;
      }
    }
  }

  private calculateReliabilityScore(info: SearXInstance): number {
    let score = 0;
    const uptime = info.uptime?.uptimeMonth ?? info.uptime?.uptimeDay ?? 0;
    score += Math.round(uptime * 2);

    const grade = info.http?.grade;
    if (grade === 'A+' || grade === 'A') score += 100;
    else if (grade === 'B') score += 60;
    else if (grade === 'C') score += 20;

    if (info.network?.dnssec && info.network.dnssec > 1) {
      score += 30;
    }

    return score;
  }

  private initSearch(): void {
    const form = document.getElementById('search-form') as HTMLFormElement;
    const input = document.getElementById('search-input') as HTMLInputElement;

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input?.value.trim();
      if (!query) return;

      const selectedUrl = this.selectElement?.value || this.getSavedInstance();

      if (!selectedUrl) {
        alert('Please select a valid SearXNG instance from the dropdown.');
        return;
      }

      // Persist whatever is actually being used for this search.
      this.saveInstance(selectedUrl);

      // Construct target URL with query and user preferences parameters
      const searchUrl = new URL(`${selectedUrl}/search`);
      searchUrl.searchParams.append('q', query);

      // Automatically append all defined user preferences
      Object.entries(this.userPreferences).forEach(([key, value]) => {
        searchUrl.searchParams.append(key, value);
      });

      window.location.href = searchUrl.toString();
    });
  }

  // ================= AUTOCOMPLETE =================

  private initAutocomplete(): void {
    if (!this.inputElement || !this.suggestionsElement) return;

    this.inputElement.addEventListener('input', () => {
      const query = this.inputElement?.value.trim() ?? '';

      window.clearTimeout(this.debounceTimer);

      if (!query) {
        this.hideSuggestions();
        return;
      }

      this.debounceTimer = window.setTimeout(() => {
        this.fetchSuggestions(query);
      }, this.DEBOUNCE_MS);
    });

    // keydown is handled on both the input and (via delegation) the list,
    // since DOM focus now actually moves onto the <li> elements.
    this.inputElement.addEventListener('keydown', (e) => this.handleKeyNav(e));
    this.suggestionsElement.addEventListener('keydown', (e) => this.handleKeyNav(e));

    // Hide the list only when focus leaves the whole search box component
    // (input + suggestions), not when it merely moves from the input to a
    // suggestion or vice versa.
    const wrapper = this.inputElement.closest('.search-input-wrapper');
    wrapper?.addEventListener('focusout', (e) => {
      const focusEvent = e as FocusEvent;
      const nextFocused = focusEvent.relatedTarget as Node | null;
      if (!nextFocused || !wrapper.contains(nextFocused)) {
        this.hideSuggestions();
      }
    });
  }

  private async fetchSuggestions(query: string): Promise<void> {
    const instanceUrl = this.selectElement?.value || this.getSavedInstance();
    if (!instanceUrl) return;

    this.showLoadingSuggestions();

    // Cancel any in-flight requests before starting a new batch
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const requests = this.AUTOCOMPLETE_PROVIDERS.map((provider) =>
      this.fetchFromProvider(instanceUrl, provider, query, signal)
    );

    const results = await Promise.allSettled(requests);

    this.hideLoadingSuggestions();

    // Query may have changed while these were in flight
    if (this.inputElement?.value.trim() !== query) return;

    const merged: string[] = [];
    const seen = new Set<string>();

    outer: for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const suggestion of result.value) {
        const key = suggestion.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(suggestion);
        if (merged.length >= this.MAX_SUGGESTIONS) break outer;
      }
    }

    this.currentSuggestions = merged;
    this.renderSuggestions();
  }

  private showLoadingSuggestions(): void {
    if (!this.suggestionsElement) return;

    this.isLoadingSuggestions = true;
    this.currentSuggestions = [];
    this.highlightedIndex = -1;

    this.suggestionsElement.innerHTML = `
      <li class="suggestion-loading" aria-disabled="true">
        <span class="spinner" aria-hidden="true"></span>
        Loading suggestions...
      </li>
    `;

    this.showSuggestions();
  }

  private hideLoadingSuggestions(): void {
    this.isLoadingSuggestions = false;
  }

  private async fetchFromProvider(
    instanceUrl: string,
    provider: string,
    query: string,
    signal: AbortSignal
  ): Promise<string[]> {
    const url = new URL(`${instanceUrl}/autocompleter`);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: query, autocomplete: provider }),
        signal,
      });

      if (!response.ok) return [];

      const data: [string, string[]] = await response.json();
      return data[1] ?? [];
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error; // propagate as rejected to Promise.allSettled
      console.error(`Autocomplete provider "${provider}" failed:`, error);
      return [];
    }
  }

  private renderSuggestions(): void {
    if (!this.suggestionsElement) return;

    this.suggestionsElement.innerHTML = '';
    this.highlightedIndex = -1;

    if (this.currentSuggestions.length === 0) {
      this.hideSuggestions();
      return;
    }

    this.currentSuggestions.forEach((suggestion, index) => {
      const li = document.createElement('li');
      li.textContent = suggestion;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      // Focusable via script (li.focus()) but skipped by normal Tab
      // traversal — we manage Tab ourselves in handleKeyNav.
      li.tabIndex = -1;

      // mousedown fires before focusout, so the click isn't lost
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectSuggestion(index);
      });

      this.suggestionsElement?.appendChild(li);
    });

    this.showSuggestions();
  }

  // Moves actual DOM focus to the input (-1) or to the <li> at `index`,
  // and keeps aria-selected in sync.
  private focusIndex(index: number): void {
    if (!this.suggestionsElement) return;
    const items = Array.from(this.suggestionsElement.querySelectorAll('li'));

    if (index === -1) {
      items.forEach((li) => li.setAttribute('aria-selected', 'false'));
      this.highlightedIndex = -1;
      this.inputElement?.focus();
      return;
    }

    const li = items[index];
    if (!li) return;

    items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    this.highlightedIndex = index;
    li.focus();
    li.scrollIntoView({ block: 'nearest' });
  }

  private handleKeyNav(e: KeyboardEvent): void {
    if (this.currentSuggestions.length === 0) return;

    const lastIndex = this.currentSuggestions.length - 1;

    if (e.key === 'Tab' && !e.shiftKey) {
      if (this.highlightedIndex === -1) {
        // From the input, Tab moves into the list
        e.preventDefault();
        this.focusIndex(0);
      } else if (this.highlightedIndex === lastIndex) {
        // Tab on the last suggestion returns focus to the input
        e.preventDefault();
        this.focusIndex(-1);
      } else {
        e.preventDefault();
        this.focusIndex(this.highlightedIndex + 1);
      }
      return;
    }

    if (e.key === 'Tab' && e.shiftKey) {
      if (this.highlightedIndex === 0) {
        // Shift+Tab on the first suggestion returns focus to the input
        e.preventDefault();
        this.focusIndex(-1);
      } else if (this.highlightedIndex > 0) {
        e.preventDefault();
        this.focusIndex(this.highlightedIndex - 1);
      }
      // Shift+Tab while the input is focused (-1): let the browser do its
      // normal thing (move focus to whatever precedes the input).
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next =
        this.highlightedIndex === -1 || this.highlightedIndex === lastIndex
          ? 0
          : this.highlightedIndex + 1;
      this.focusIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = this.highlightedIndex <= 0 ? lastIndex : this.highlightedIndex - 1;
      this.focusIndex(prev);
    } else if (e.key === 'Enter') {
      if (this.highlightedIndex >= 0) {
        e.preventDefault();
        this.selectSuggestion(this.highlightedIndex);
      }
      // Enter while the input is focused (-1): let the form submit normally
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.hideSuggestions();
      this.inputElement?.focus();
    }
  }

  // Click or Enter on a suggestion — fills the input, closes the list,
  // returns focus to the input, and submits.
  private selectSuggestion(index: number): void {
    const suggestion = this.currentSuggestions[index];
    if (!suggestion || !this.inputElement) return;

    this.inputElement.value = suggestion;
    this.hideSuggestions();
    this.inputElement.focus();
    (document.getElementById('search-form') as HTMLFormElement)?.requestSubmit();
  }

  private showSuggestions(): void {
    this.suggestionsElement?.removeAttribute('hidden');
  }

  private hideSuggestions(): void {
    this.suggestionsElement?.setAttribute('hidden', '');
    this.currentSuggestions = [];
    this.highlightedIndex = -1;
  }
}

new SearXHomeManager();
