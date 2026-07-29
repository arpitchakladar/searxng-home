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

  // Autocomplete state
  private debounceTimer: number | undefined;
  private abortController: AbortController | null = null;
  private currentSuggestions: string[] = [];
  private highlightedIndex = -1;
  private readonly DEBOUNCE_MS = 200;

  // Define your persistent global preferences here
  private readonly userPreferences: Record<string, string> = {
    language: 'en', // e.g., English language
    safesearch: '1', // 0: None, 1: Moderate, 2: Strict
    categories: 'general', // Default category (general, science, IT, etc.)
    engines: 'google',
    autocomplete: 'google',
    simple_style: 'black',
  };

  private readonly AUTOCOMPLETE_PROVIDERS: string[] = [
    'google',
    'duckduckgo',
    'brave',
    'startpage',
    'wikipedia',
    'swisscows',
  ];

  private readonly MAX_SUGGESTIONS = 10;

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

    this.inputElement.addEventListener('keydown', (e) => this.handleKeyNav(e));

    // Hide on blur, but delay so a click on a suggestion still registers first
    this.inputElement.addEventListener('blur', () => {
      window.setTimeout(() => this.hideSuggestions(), 120);
    });

    this.inputElement.addEventListener('focus', () => {
      if (this.currentSuggestions.length > 0) {
        this.showSuggestions();
      }
    });
  }

  private async fetchSuggestions(query: string): Promise<void> {
    const instanceUrl = this.selectElement?.value || this.getSavedInstance();
    if (!instanceUrl) return;

    // Cancel any in-flight requests before starting a new batch
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const requests = this.AUTOCOMPLETE_PROVIDERS.map((provider) =>
      this.fetchFromProvider(instanceUrl, provider, query, signal)
    );

    const results = await Promise.allSettled(requests);

    // Query may have changed while these were in flight
    if (this.inputElement?.value.trim() !== query) return;

    const merged: string[] = [];
    const seen = new Set<string>();

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const suggestion of result.value) {
        const key = suggestion.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(suggestion);
        if (merged.length >= this.MAX_SUGGESTIONS) break;
      }
      if (merged.length >= this.MAX_SUGGESTIONS) break;
    }

    this.currentSuggestions = merged;
    this.renderSuggestions();
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
      if ((error as Error).name === 'AbortError') throw error; // propagate to Promise.allSettled as rejected
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

      // mousedown fires before blur, so the click isn't lost
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectSuggestion(index);
      });

      this.suggestionsElement?.appendChild(li);
    });

    this.showSuggestions();
  }

  private handleKeyNav(e: KeyboardEvent): void {
    if (this.currentSuggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlightedIndex = (this.highlightedIndex + 1) % this.currentSuggestions.length;
      this.updateHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlightedIndex =
        (this.highlightedIndex - 1 + this.currentSuggestions.length) %
        this.currentSuggestions.length;
      this.updateHighlight();
    } else if (e.key === 'Enter') {
      if (this.highlightedIndex >= 0) {
        e.preventDefault();
        this.selectSuggestion(this.highlightedIndex);
      }
      // otherwise let the form submit naturally with whatever's typed
    } else if (e.key === 'Escape') {
      this.hideSuggestions();
    }
  }

  private updateHighlight(): void {
    if (!this.suggestionsElement) return;
    const items = this.suggestionsElement.querySelectorAll('li');
    items.forEach((li, index) => {
      li.setAttribute('aria-selected', String(index === this.highlightedIndex));
    });
    items[this.highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private selectSuggestion(index: number): void {
    const suggestion = this.currentSuggestions[index];
    if (!suggestion || !this.inputElement) return;

    this.inputElement.value = suggestion;
    this.hideSuggestions();
    this.inputElement.focus();

    // Submit immediately on selection — remove this line if you'd rather
    // just fill the box and let the user hit Enter themselves.
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
