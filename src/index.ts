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
  private readonly CACHE_KEY = 'searx_selected_instance';

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
    this.initSearch();
    this.fetchInstances();
    this.autofocusInput();
  }

  private autofocusInput(): void {
    if (this.inputElement) {
      this.inputElement.focus();

      // Optional: Handle scenarios where browser focus shifts late during load
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

      const savedInstance = localStorage.getItem(this.CACHE_KEY);

      validInstances.forEach(({ url, info, score }) => {
        const hostname = new URL(url).hostname;
        const option = document.createElement('option');
        option.value = url;

        const gradeStr = info.http?.grade ? ` [${info.http.grade}]` : '';
        const uptimeVal = info.uptime?.uptimeMonth ?? info.uptime?.uptimeDay ?? 0;
        const uptimeStr = uptimeVal ? ` [${uptimeVal}%]` : '';

        option.textContent = `${hostname}${gradeStr}${uptimeStr} (Score: ${score})`;

        if (savedInstance === url) {
          option.selected = true;
        }

        this.selectElement?.appendChild(option);
      });

      if (!localStorage.getItem(this.CACHE_KEY) && validInstances[0]) {
        localStorage.setItem(this.CACHE_KEY, validInstances[0].url);
      }

      this.selectElement.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        if (target?.value) {
          localStorage.setItem(this.CACHE_KEY, target.value);
        }
      });
    } catch (error) {
      console.error('Failed to load instances from searx.space:', error);
      if (this.selectElement) {
        this.selectElement.innerHTML =
          '<option value="https://search.ononoki.org">search.ononoki.org (Fallback)</option>';
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

      const selectedUrl = this.selectElement?.value || localStorage.getItem(this.CACHE_KEY);

      if (!selectedUrl) {
        alert('Please select a valid SearXNG instance from the dropdown.');
        return;
      }

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
}

new SearXHomeManager();
