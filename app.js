/* ============================================
   Deficit — Personal Weight Loss Tracker
   Application Logic
   ============================================ */

// ────────────────────────────────────────────
// IndexedDB Wrapper
// ────────────────────────────────────────────
class DB {
  constructor() {
    this.db = null;
    this.DB_NAME = 'deficit-tracker';
    this.DB_VERSION = 2;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('profile')) {
          db.createObjectStore('profile', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('weight_logs')) {
          db.createObjectStore('weight_logs', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('food_items')) {
          const fi = db.createObjectStore('food_items', { keyPath: 'id' });
          fi.createIndex('barcode', 'barcode', { unique: false });
          fi.createIndex('use_count', 'use_count', { unique: false });
        }
        if (!db.objectStoreNames.contains('food_logs')) {
          const fl = db.createObjectStore('food_logs', { keyPath: 'id', autoIncrement: true });
          fl.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  _tx(storeName, mode = 'readonly') {
    const tx = this.db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  async put(storeName, data) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getAllByIndex(storeName, indexName, key) {
    return new Promise((resolve, reject) => {
      const store = this._tx(storeName);
      const idx = store.index(indexName);
      const req = idx.getAll(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async clearStore(storeName) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

// ────────────────────────────────────────────
// TDEE Calculator (Mifflin-St Jeor)
// ────────────────────────────────────────────
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9
};

function calculateBMR(gender, weightKg, heightCm, age) {
  if (gender === 'male') {
    return (10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5;
  }
  return (10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161;
}

function calculateTDEE(profile) {
  const bmr = calculateBMR(profile.gender, profile.current_weight_kg, profile.height_cm, profile.age);
  return Math.round(bmr * (ACTIVITY_MULTIPLIERS[profile.activity_level] || 1.55));
}

function calculateBudget(tdee, deficit, gender) {
  const floor = gender === 'male' ? 1500 : 1200;
  return Math.max(Math.round(tdee - deficit), floor);
}

// ────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const MEAL_ICONS = { breakfast: '☀️', lunch: '🌤️', dinner: '🌙', snack: '🍿' };
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];

// ────────────────────────────────────────────
// OpenFoodFacts API
// ────────────────────────────────────────────
async function searchFoods(query) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,brands,nutriments,serving_size,serving_quantity`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.products || [])
    .filter(p => p.product_name && p.nutriments && p.nutriments['energy-kcal_100g'] != null)
    .map(p => ({
      id: p.code || `off-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: p.product_name,
      brand: p.brands || '',
      barcode: p.code || '',
      calories_per_100g: p.nutriments['energy-kcal_100g'] || 0,
      protein_per_100g: p.nutriments['proteins_100g'] || 0,
      carbs_per_100g: p.nutriments['carbohydrates_100g'] || 0,
      fat_per_100g: p.nutriments['fat_100g'] || 0,
      serving_size_g: p.serving_quantity || 100,
      serving_label: p.serving_size || '100g',
      source: 'openfoodfacts',
      use_count: 0
    }));
}

async function lookupBarcode(barcode) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  const p = data.product;
  return {
    id: barcode,
    name: p.product_name || 'Unknown Product',
    brand: p.brands || '',
    barcode,
    calories_per_100g: p.nutriments?.['energy-kcal_100g'] || 0,
    protein_per_100g: p.nutriments?.['proteins_100g'] || 0,
    carbs_per_100g: p.nutriments?.['carbohydrates_100g'] || 0,
    fat_per_100g: p.nutriments?.['fat_100g'] || 0,
    serving_size_g: p.serving_quantity || 100,
    serving_label: p.serving_size || '100g',
    source: 'openfoodfacts',
    use_count: 0
  };
}

// ────────────────────────────────────────────
// Main Application
// ────────────────────────────────────────────
class App {
  constructor() {
    this.db = new DB();
    this.profile = null;
    this.weightChart = null;
    this.calorieChart = null;
    this.selectedMeal = 'breakfast';
    this.selectedFood = null;
    this.searchTimeout = null;
  }

  // ── Initialization ──
  async init() {
    await this.db.init();
    this.profile = await this.db.get('profile', 1);

    if (!this.profile) {
      this.showView('setup');
    } else {
      this.showView('dashboard');
      await this.renderDashboard();
    }

    this.bindEvents();
    this.registerSW();
  }

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  // ── Navigation ──
  showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const view = document.getElementById(`${name}-view`);
    if (view) {
      view.classList.remove('hidden');
      // Re-trigger animation
      view.style.animation = 'none';
      view.offsetHeight; // force reflow
      view.style.animation = '';
    }

    // Update nav
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
    if (navBtn) navBtn.classList.add('active');

    // Show/hide bottom nav
    const nav = document.getElementById('bottom-nav');
    if (nav) nav.style.display = name === 'setup' ? 'none' : 'flex';
  }

  // ── Events ──
  bindEvents() {
    // Setup form
    document.getElementById('setup-form').addEventListener('submit', (e) => this.handleSetup(e));
    const setupDeficit = document.getElementById('setup-deficit');
    setupDeficit.addEventListener('input', () => this.updateDeficitLabel('setup'));

    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const view = btn.dataset.view;
        this.showView(view);
        if (view === 'dashboard') await this.renderDashboard();
        if (view === 'history') await this.renderHistory();
        if (view === 'settings') this.populateSettings();
      });
    });

    // Dashboard buttons
    document.getElementById('btn-log-food').addEventListener('click', () => this.openFoodModal());
    document.getElementById('btn-quick-add').addEventListener('click', () => this.openQuickAddModal());
    document.getElementById('btn-log-weight').addEventListener('click', () => this.openWeightModal());

    // Food modal & Custom adjustment
    document.getElementById('food-modal-close').addEventListener('click', () => this.closeModal('food-modal'));
    document.getElementById('food-search-input').addEventListener('input', (e) => this.handleFoodSearch(e));
    document.getElementById('btn-barcode-lookup').addEventListener('click', () => this.handleBarcodeLookup());
    document.getElementById('food-detail-back').addEventListener('click', () => this.hideFoodDetail());
    document.getElementById('serving-amount').addEventListener('input', () => this.updateNutritionPreview());
    document.getElementById('btn-confirm-food').addEventListener('click', () => this.confirmFoodLog());

    // Custom adjust controls
    document.getElementById('btn-toggle-custom-adjust').addEventListener('click', () => this.toggleCustomAdjustFields());
    ['custom-calories', 'custom-protein', 'custom-carbs', 'custom-fat'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => this.onCustomAdjustInput());
    });

    // Create custom item modal
    document.getElementById('btn-open-create-custom').addEventListener('click', () => this.openCreateCustomModal());
    document.getElementById('create-custom-close').addEventListener('click', () => this.closeModal('create-custom-modal'));
    document.getElementById('create-custom-form').addEventListener('submit', (e) => this.handleCreateCustom(e));

    // Meal tabs in food modal
    document.getElementById('meal-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.meal-tab');
      if (tab) {
        document.querySelectorAll('#meal-tabs .meal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.selectedMeal = tab.dataset.meal;
      }
    });

    // Quick add
    document.getElementById('quick-add-close').addEventListener('click', () => this.closeModal('quick-add-modal'));
    document.getElementById('quick-add-form').addEventListener('submit', (e) => this.handleQuickAdd(e));
    document.getElementById('quick-add-meal-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.meal-tab');
      if (tab) {
        document.querySelectorAll('#quick-add-meal-tabs .meal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      }
    });

    // Weight modal
    document.getElementById('weight-modal-close').addEventListener('click', () => this.closeModal('weight-modal'));
    document.getElementById('weight-form').addEventListener('submit', (e) => this.handleWeightLog(e));

    // Settings
    document.getElementById('settings-form').addEventListener('submit', (e) => this.handleSettingsSave(e));
    const settingsDeficit = document.getElementById('settings-deficit');
    settingsDeficit.addEventListener('input', () => this.updateDeficitLabel('settings'));
    document.getElementById('btn-export-data').addEventListener('click', () => this.exportData());
    document.getElementById('btn-clear-data').addEventListener('click', () => this.clearData());

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) this.closeModal(m.id);
      });
    });
  }

  // ── Setup ──
  async handleSetup(e) {
    e.preventDefault();
    const weight = parseFloat(document.getElementById('setup-weight').value);
    this.profile = {
      id: 1,
      name: document.getElementById('setup-name').value.trim(),
      gender: document.getElementById('setup-gender').value,
      age: parseInt(document.getElementById('setup-age').value),
      height_cm: parseFloat(document.getElementById('setup-height').value),
      current_weight_kg: weight,
      activity_level: document.getElementById('setup-activity').value,
      deficit_target: parseInt(document.getElementById('setup-deficit').value),
      created_at: new Date().toISOString()
    };
    await this.db.put('profile', this.profile);

    // Also log initial weight
    await this.db.put('weight_logs', {
      date: todayStr(),
      weight_kg: weight,
      logged_at: new Date().toISOString()
    });

    this.showView('dashboard');
    await this.renderDashboard();
    this.toast('Welcome! Let\'s start tracking 🔥');
  }

  updateDeficitLabel(prefix) {
    const slider = document.getElementById(`${prefix}-deficit`);
    const valueEl = document.getElementById(`${prefix}-deficit-value`);
    const rateEl = document.getElementById(`${prefix}-deficit-rate`);
    const val = parseInt(slider.value);
    valueEl.textContent = `${val} kcal/day`;
    rateEl.textContent = `≈ ${(val / 7700 * 7).toFixed(2)} kg/week`;
  }

  // ── Dashboard Rendering ──
  async renderDashboard() {
    if (!this.profile) return;

    // Update greeting and date
    document.getElementById('dash-greeting').textContent = `${getGreeting()}, ${this.profile.name}`;
    document.getElementById('dash-date').textContent = formatDateLong(todayStr());

    // Calculate TDEE and budget
    const tdee = calculateTDEE(this.profile);
    const budget = calculateBudget(tdee, this.profile.deficit_target, this.profile.gender);

    // Get today's food logs
    const allLogs = await this.db.getAll('food_logs');
    const today = todayStr();
    const todayLogs = allLogs.filter(l => l.date === today);
    const consumed = Math.round(todayLogs.reduce((sum, l) => sum + l.calories, 0));
    const remaining = budget - consumed;

    // Update calorie ring
    this.updateCalorieRing(budget, consumed, remaining);

    // Update stats
    document.getElementById('budget-value').textContent = budget.toLocaleString();
    document.getElementById('consumed-value').textContent = consumed.toLocaleString();

    // Calculate streak
    const streak = await this.calculateStreak(allLogs);
    document.getElementById('streak-value').textContent = streak;

    // Calculate today's macro nutrition totals
    const totalProtein = Math.round(todayLogs.reduce((sum, l) => sum + (l.protein_g || 0), 0) * 10) / 10;
    const totalCarbs = Math.round(todayLogs.reduce((sum, l) => sum + (l.carbs_g || 0), 0) * 10) / 10;
    const totalFat = Math.round(todayLogs.reduce((sum, l) => sum + (l.fat_g || 0), 0) * 10) / 10;

    this.renderNutritionSummary(totalProtein, totalCarbs, totalFat);

    // Render 1-Tap Favorites strip
    await this.renderFavoritesStrip();

    // Render today's log list
    await this.renderTodayLogs(todayLogs);

    // Render weight chart
    await this.renderWeightChart();

    // Auto-select meal type based on time
    this.autoSelectMealType();
  }

  renderNutritionSummary(pG, cG, fG) {
    const pCal = Math.round(pG * 4);
    const cCal = Math.round(cG * 4);
    const fCal = Math.round(fG * 9);
    const totalMacroCal = pCal + cCal + fCal;

    const elProt = document.getElementById('total-protein');
    const elCarb = document.getElementById('total-carbs');
    const elFat = document.getElementById('total-fat');
    if (!elProt || !elCarb || !elFat) return;

    elProt.textContent = `${pG}g`;
    document.getElementById('cal-protein').textContent = `${pCal} kcal`;
    elCarb.textContent = `${cG}g`;
    document.getElementById('cal-carbs').textContent = `${cCal} kcal`;
    elFat.textContent = `${fG}g`;
    document.getElementById('cal-fat').textContent = `${fCal} kcal`;

    const pPct = totalMacroCal > 0 ? Math.round((pCal / totalMacroCal) * 100) : 0;
    const cPct = totalMacroCal > 0 ? Math.round((cCal / totalMacroCal) * 100) : 0;
    const fPct = totalMacroCal > 0 ? Math.max(0, 100 - pPct - cPct) : 0;

    document.getElementById('macro-bar-protein').style.width = `${pPct}%`;
    document.getElementById('macro-bar-carbs').style.width = `${cPct}%`;
    document.getElementById('macro-bar-fat').style.width = `${fPct}%`;

    document.getElementById('macro-ratio-label').textContent = `${pPct}% P · ${cPct}% C · ${fPct}% F`;
  }

  updateCalorieRing(budget, consumed, remaining) {
    const display = document.getElementById('calorie-display');
    const ring = document.getElementById('ring-progress');
    const numberEl = document.getElementById('remaining-calories');

    const circumference = 2 * Math.PI * 85; // r=85
    const progress = Math.min(consumed / budget, 1.5); // allow overshoot visual
    const offset = circumference * (1 - progress);

    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = Math.max(offset, 0);

    // Animate number
    numberEl.textContent = Math.abs(remaining).toLocaleString();
    const unitEl = display.querySelector('.calorie-unit');

    // Color state
    display.classList.remove('status-green', 'status-yellow', 'status-red');
    if (remaining <= 0) {
      display.classList.add('status-red');
      unitEl.textContent = 'kcal over 😬';
    } else if (remaining <= budget * 0.3) {
      display.classList.add('status-yellow');
      unitEl.textContent = 'kcal left ⚠️';
    } else {
      display.classList.add('status-green');
      unitEl.textContent = 'kcal left ✅';
    }
  }

  // ── 1-Tap Favorites Strip ──
  async renderFavoritesStrip() {
    const strip = document.getElementById('favorites-strip');
    if (!strip) return;

    let favorites = await this.db.getAll('favorites');

    if (favorites.length === 0) {
      // Auto-suggest top items if no explicit favorites created yet
      const items = await this.db.getAll('food_items');
      items.sort((a, b) => (b.use_count || 0) - (a.use_count || 0));
      const topItems = items.slice(0, 5);

      if (topItems.length > 0) {
        favorites = topItems.map(item => ({
          name: item.name,
          calories: Math.round(item.calories_per_100g * ((item.serving_size_g || 100) / 100)),
          serving_size: item.serving_size_g || 100,
          serving_unit: 'g',
          meal_type: 'snack',
          food_item_id: item.id,
          is_suggested: true
        }));
      }
    }

    if (favorites.length === 0) {
      strip.innerHTML = `
        <div class="favorites-empty-tip">
          💡 <strong>1-Tap Fast Logging:</strong> Tap the ⭐ star on any meal or drink in your log to save it here for instant 1-tap logging!
        </div>`;
      return;
    }

    strip.innerHTML = favorites.map(fav => {
      const mealIcon = MEAL_ICONS[fav.meal_type || 'snack'] || '🍿';
      return `
        <div class="favorite-pill" data-fav-name="${this.escapeHtml(fav.name)}" data-fav-cal="${fav.calories}" data-fav-size="${fav.serving_size || ''}" data-fav-unit="${fav.serving_unit || ''}" data-fav-meal="${fav.meal_type || 'snack'}">
          <span class="favorite-pill-icon">${mealIcon}</span>
          <div class="favorite-pill-info">
            <span class="favorite-pill-name">${this.escapeHtml(fav.name)}</span>
            <span class="favorite-pill-meta">${Math.round(fav.calories)} kcal ${fav.serving_size ? '· ' + fav.serving_size + (fav.serving_unit || 'g') : ''}</span>
          </div>
          <span class="favorite-pill-add" title="1-Tap Log">+</span>
        </div>
      `;
    }).join('');

    // Bind 1-tap logging
    strip.querySelectorAll('.favorite-pill').forEach(pill => {
      pill.addEventListener('click', async () => {
        const name = pill.dataset.favName;
        const calories = parseInt(pill.dataset.favCal);
        const serving_size = pill.dataset.favSize ? parseFloat(pill.dataset.favSize) : null;
        const serving_unit = pill.dataset.favUnit || null;
        const meal_type = pill.dataset.favMeal || this.selectedMeal;

        await this.db.put('food_logs', {
          food_item_id: null,
          food_name: name,
          calories: calories,
          serving_size: serving_size,
          serving_unit: serving_unit,
          meal_type: meal_type,
          date: todayStr(),
          logged_at: new Date().toISOString(),
          is_quick_add: 0
        });

        await this.renderDashboard();
        this.toast(`1-Tap Logged ${name} (${calories} kcal) ⚡`);
      });
    });
  }

  async renderTodayLogs(logs) {
    const list = document.getElementById('todays-log-list');
    if (!list) return;

    if (logs.length === 0) {
      list.innerHTML = `
        <div class="log-empty" id="log-empty">
          <p>No food logged yet today.</p>
          <p class="text-muted">Tap below to start logging.</p>
        </div>`;
      return;
    }

    // Fetch favorites to check which items are starred
    const favorites = await this.db.getAll('favorites');
    const starredNames = new Set(favorites.map(f => f.name.toLowerCase()));

    // Group by meal type
    const groups = {};
    for (const meal of MEAL_ORDER) groups[meal] = [];
    logs.forEach(l => {
      const m = l.meal_type || 'snack';
      if (!groups[m]) groups[m] = [];
      groups[m].push(l);
    });

    let html = '';
    for (const meal of MEAL_ORDER) {
      const items = groups[meal];
      if (items.length === 0) continue;
      const total = Math.round(items.reduce((s, i) => s + i.calories, 0));
      html += `<div class="meal-group-header">
        <span>${MEAL_ICONS[meal]} ${meal.charAt(0).toUpperCase() + meal.slice(1)}</span>
        <span class="meal-group-total">${total} kcal</span>
      </div>`;
      for (const item of items) {
        const isStarred = starredNames.has(item.food_name.toLowerCase());
        const metaServing = item.serving_size ? item.serving_size + (item.serving_unit || 'g') : '';
        const metaMacros = (item.protein_g != null || item.carbs_g != null || item.fat_g != null)
          ? ` · P: ${item.protein_g || 0}g  C: ${item.carbs_g || 0}g  F: ${item.fat_g || 0}g`
          : '';
        html += `<div class="log-item" data-id="${item.id}">
          <div class="log-item-left">
            <div class="log-item-info">
              <div class="log-item-name">${this.escapeHtml(item.food_name)}</div>
              <div class="log-item-meta">${metaServing + metaMacros}</div>
            </div>
          </div>
          <span class="log-item-calories">${Math.round(item.calories)}</span>
          <div class="log-item-actions">
            <button class="log-item-btn log-item-star ${isStarred ? 'is-starred' : ''}" title="${isStarred ? 'Unstar' : 'Pin to 1-Tap Favorites'}" data-star-name="${this.escapeHtml(item.food_name)}" data-star-cal="${item.calories}" data-star-size="${item.serving_size || ''}" data-star-unit="${item.serving_unit || ''}" data-star-meal="${item.meal_type || 'snack'}">★</button>
            <button class="log-item-btn log-item-repeat" title="Log 1-Tap Again" data-repeat-id="${item.id}">+</button>
            <button class="log-item-btn log-item-delete" title="Delete" data-delete-id="${item.id}">&times;</button>
          </div>
        </div>`;
      }
    }
    list.innerHTML = html;

    // Bind star buttons (toggle favorite)
    list.querySelectorAll('.log-item-star').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.starName;
        const calories = parseInt(btn.dataset.starCal);
        const serving_size = btn.dataset.starSize ? parseFloat(btn.dataset.starSize) : null;
        const serving_unit = btn.dataset.starUnit || null;
        const meal_type = btn.dataset.starMeal || 'snack';

        const existingFavs = await this.db.getAll('favorites');
        const match = existingFavs.find(f => f.name.toLowerCase() === name.toLowerCase());

        if (match) {
          await this.db.delete('favorites', match.id);
          this.toast(`Removed ${name} from 1-Tap Favorites`);
        } else {
          await this.db.put('favorites', {
            name,
            calories,
            serving_size,
            serving_unit,
            meal_type,
            created_at: new Date().toISOString()
          });
          this.toast(`Saved ${name} to 1-Tap Favorites ⭐`);
        }
        await this.renderDashboard();
      });
    });

    // Bind repeat buttons (log 1-tap again)
    list.querySelectorAll('.log-item-repeat').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.repeatId);
        const originalLog = logs.find(l => l.id === id);
        if (originalLog) {
          await this.db.put('food_logs', {
            food_item_id: originalLog.food_item_id,
            food_name: originalLog.food_name,
            calories: originalLog.calories,
            serving_size: originalLog.serving_size,
            serving_unit: originalLog.serving_unit,
            meal_type: originalLog.meal_type,
            date: todayStr(),
            logged_at: new Date().toISOString(),
            is_quick_add: originalLog.is_quick_add
          });
          await this.renderDashboard();
          this.toast(`Logged ${originalLog.food_name} again ⚡`);
        }
      });
    });

    // Bind delete buttons
    list.querySelectorAll('.log-item-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.deleteId);
        await this.db.delete('food_logs', id);
        await this.renderDashboard();
        this.toast('Entry removed');
      });
    });
  }

  autoSelectMealType() {
    const h = new Date().getHours();
    if (h < 11) this.selectedMeal = 'breakfast';
    else if (h < 15) this.selectedMeal = 'lunch';
    else if (h < 21) this.selectedMeal = 'dinner';
    else this.selectedMeal = 'snack';
  }

  // ── Streak Calculation ──
  async calculateStreak(allLogs) {
    if (!this.profile) return 0;
    const tdee = calculateTDEE(this.profile);
    const budget = calculateBudget(tdee, this.profile.deficit_target, this.profile.gender);

    // Group logs by date
    const byDate = {};
    allLogs.forEach(l => {
      if (!byDate[l.date]) byDate[l.date] = 0;
      byDate[l.date] += l.calories;
    });

    // Count consecutive days in deficit going backwards
    let streak = 0;
    let checkDate = todayStr();

    // Check today: if no logs yet, don't count it but don't break streak
    if (!byDate[checkDate] || byDate[checkDate] === 0) {
      checkDate = daysAgo(1);
    }

    for (let i = 0; i < 365; i++) {
      const dateStr = daysAgo(i + (checkDate === daysAgo(1) ? 1 : 0));
      const consumed = byDate[dateStr];
      if (consumed == null) break; // No data for this day
      if (consumed <= budget) {
        streak++;
      } else {
        break;
      }
    }

    return streak;
  }

  // ── Weight Chart ──
  async renderWeightChart() {
    const logs = await this.db.getAll('weight_logs');
    logs.sort((a, b) => a.date.localeCompare(b.date));

    const recent = logs.slice(-30);
    const summaryEl = document.getElementById('weight-summary');
    const badgeEl = document.getElementById('weight-change-badge');

    if (recent.length === 0) {
      summaryEl.innerHTML = '<span>Log your weight to see trends</span>';
      badgeEl.textContent = '—';
      return;
    }

    // Calculate 7-day EMA
    const emaWeights = this.calculateEMA(recent.map(l => l.weight_kg), 0.3);
    const latestWeight = recent[recent.length - 1].weight_kg;
    const latestEMA = emaWeights[emaWeights.length - 1];

    // Weekly change
    let weeklyChange = null;
    if (recent.length >= 7) {
      const weekAgoEMA = emaWeights[Math.max(0, emaWeights.length - 7)];
      weeklyChange = latestEMA - weekAgoEMA;
    }

    summaryEl.innerHTML = `<span style="font-weight:700">${latestWeight.toFixed(1)} kg</span>` +
      (weeklyChange != null ? ` <span style="color: ${weeklyChange <= 0 ? '#34c759' : '#e74c3c'}; font-weight:600">(${weeklyChange <= 0 ? '↓' : '↑'} ${Math.abs(weeklyChange).toFixed(1)} kg this week)</span>` : '');

    if (weeklyChange != null) {
      badgeEl.textContent = `${weeklyChange <= 0 ? '↓' : '↑'} ${Math.abs(weeklyChange).toFixed(1)} kg/wk`;
      badgeEl.style.background = weeklyChange <= 0 ? 'var(--green-bg)' : 'var(--red-bg)';
      badgeEl.style.color = weeklyChange <= 0 ? 'var(--green)' : 'var(--red)';
    }

    // Update profile weight for adaptive TDEE
    if (this.profile.current_weight_kg !== latestWeight) {
      this.profile.current_weight_kg = latestWeight;
      await this.db.put('profile', this.profile);
    }

    // Render chart
    const ctx = document.getElementById('weight-chart');
    if (this.weightChart) this.weightChart.destroy();

    this.weightChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: recent.map(l => formatDate(l.date)),
        datasets: [
          {
            label: 'Weight',
            data: recent.map(l => l.weight_kg),
            borderColor: 'rgba(74, 144, 217, 0.25)',
            backgroundColor: 'rgba(74, 144, 217, 0.03)',
            pointBackgroundColor: 'rgba(74, 144, 217, 0.5)',
            pointRadius: 3,
            borderWidth: 1.5,
            tension: 0,
            fill: false
          },
          {
            label: 'Trend (EMA)',
            data: emaWeights,
            borderColor: '#4a90d9',
            backgroundColor: 'rgba(74, 144, 217, 0.06)',
            pointRadius: 0,
            borderWidth: 2.5,
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: this.getChartOptions('kg')
    });
  }

  calculateEMA(values, alpha) {
    if (values.length === 0) return [];
    const ema = [values[0]];
    for (let i = 1; i < values.length; i++) {
      ema.push(alpha * values[i] + (1 - alpha) * ema[i - 1]);
    }
    return ema.map(v => Math.round(v * 10) / 10);
  }

  getChartOptions(unit) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a2e',
          titleColor: '#fff',
          bodyColor: '#a0a0b0',
          borderColor: 'rgba(0,0,0,0.08)',
          borderWidth: 1,
          cornerRadius: 10,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} ${unit}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0, 0, 0, 0.04)' },
          ticks: { color: '#a0a0b0', font: { size: 10, family: 'Inter' }, maxRotation: 0, maxTicksLimit: 6 },
          border: { display: false }
        },
        y: {
          grid: { color: 'rgba(0, 0, 0, 0.04)' },
          ticks: { color: '#a0a0b0', font: { size: 10, family: 'Inter' }, callback: (v) => v + unit },
          border: { display: false }
        }
      }
    };
  }

  // ── Food Modal ──
  openFoodModal() {
    this.showModal('food-modal');
    this.hideFoodDetail();
    document.getElementById('food-search-input').value = '';
    document.getElementById('barcode-input').value = '';
    document.getElementById('food-search-section').classList.add('hidden');
    document.getElementById('food-recent-section').classList.remove('hidden');
    this.loadRecentFoods();

    // Set active meal tab
    document.querySelectorAll('#meal-tabs .meal-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.meal === this.selectedMeal);
    });

    setTimeout(() => document.getElementById('food-search-input').focus(), 300);
  }

  async loadRecentFoods() {
    const items = await this.db.getAll('food_items');
    items.sort((a, b) => (b.use_count || 0) - (a.use_count || 0));
    const recent = items.slice(0, 20);

    const list = document.getElementById('food-recent-list');
    if (recent.length === 0) {
      list.innerHTML = '<div class="food-list-empty">Search for foods to get started</div>';
      return;
    }

    list.innerHTML = recent.map(item => `
      <div class="food-list-item" data-food-id="${item.id}">
        <div class="food-list-item-info">
          <div class="food-list-item-name">${this.escapeHtml(item.name)}</div>
          <div class="food-list-item-brand">${this.escapeHtml(item.brand || '')} · ${Math.round(item.calories_per_100g)} kcal/100g</div>
        </div>
        <div class="food-list-item-kcal">${Math.round(item.calories_per_100g)}</div>
      </div>
    `).join('');

    list.querySelectorAll('.food-list-item').forEach(el => {
      el.addEventListener('click', async () => {
        const food = recent.find(f => f.id === el.dataset.foodId);
        if (food) this.showFoodDetail(food);
      });
    });
  }

  handleFoodSearch(e) {
    const query = e.target.value.trim();
    clearTimeout(this.searchTimeout);

    if (query.length < 2) {
      document.getElementById('food-search-section').classList.add('hidden');
      document.getElementById('food-recent-section').classList.remove('hidden');
      return;
    }

    document.getElementById('search-spinner').classList.remove('hidden');
    this.searchTimeout = setTimeout(async () => {
      try {
        const results = await searchFoods(query);
        this.displaySearchResults(results);
      } catch (err) {
        document.getElementById('food-search-results').innerHTML =
          '<div class="food-list-empty">Search failed. Check your connection.</div>';
      }
      document.getElementById('search-spinner').classList.add('hidden');
    }, 400);
  }

  displaySearchResults(results) {
    document.getElementById('food-recent-section').classList.add('hidden');
    document.getElementById('food-search-section').classList.remove('hidden');
    document.getElementById('search-results-label').textContent = `${results.length} results`;

    const list = document.getElementById('food-search-results');
    if (results.length === 0) {
      list.innerHTML = '<div class="food-list-empty">No foods found. Try a different search.</div>';
      return;
    }

    list.innerHTML = results.map(item => `
      <div class="food-list-item" data-food-idx="${results.indexOf(item)}">
        <div class="food-list-item-info">
          <div class="food-list-item-name">${this.escapeHtml(item.name)}</div>
          <div class="food-list-item-brand">${this.escapeHtml(item.brand || 'Generic')} · ${Math.round(item.calories_per_100g)} kcal/100g</div>
        </div>
        <div class="food-list-item-kcal">${Math.round(item.calories_per_100g)}</div>
      </div>
    `).join('');

    list.querySelectorAll('.food-list-item').forEach(el => {
      el.addEventListener('click', () => {
        const food = results[parseInt(el.dataset.foodIdx)];
        if (food) this.showFoodDetail(food);
      });
    });
  }

  async handleBarcodeLookup() {
    const barcode = document.getElementById('barcode-input').value.trim();
    if (!barcode) return;

    document.getElementById('search-spinner').classList.remove('hidden');
    try {
      const food = await lookupBarcode(barcode);
      if (food) {
        this.showFoodDetail(food);
      } else {
        this.toast('Product not found for this barcode');
      }
    } catch (err) {
      this.toast('Barcode lookup failed');
    }
    document.getElementById('search-spinner').classList.add('hidden');
  }

  showFoodDetail(food) {
    this.selectedFood = food;
    document.getElementById('food-detail').classList.remove('hidden');
    document.querySelector('.food-list-section').style.display = 'none';
    document.querySelector('.search-container').style.display = 'none';
    document.querySelector('.barcode-row').style.display = 'none';
    const customRow = document.querySelector('.create-custom-row');
    if (customRow) customRow.style.display = 'none';

    document.getElementById('food-detail-name').textContent = food.name;
    document.getElementById('food-detail-brand').textContent = food.brand || 'Generic';

    // Hide custom adjust fields by default
    const adjustFields = document.getElementById('custom-adjust-fields');
    if (adjustFields) adjustFields.classList.add('hidden');

    // Set serving
    const servingAmount = document.getElementById('serving-amount');
    servingAmount.value = food.serving_size_g || 100;

    // Populate serving unit options
    const unitSelect = document.getElementById('serving-unit');
    unitSelect.innerHTML = '<option value="g">grams (g)</option>';
    if (food.serving_label && food.serving_label !== '100g') {
      unitSelect.innerHTML += `<option value="serving">${this.escapeHtml(food.serving_label)}</option>`;
    }

    this.updateNutritionPreview();
  }

  hideFoodDetail() {
    document.getElementById('food-detail').classList.add('hidden');
    document.querySelector('.food-list-section').style.display = '';
    document.querySelector('.search-container').style.display = '';
    document.querySelector('.barcode-row').style.display = '';
    const customRow = document.querySelector('.create-custom-row');
    if (customRow) customRow.style.display = '';
    this.selectedFood = null;
  }

  toggleCustomAdjustFields() {
    const fields = document.getElementById('custom-adjust-fields');
    if (!fields) return;
    fields.classList.toggle('hidden');
    if (!fields.classList.contains('hidden')) {
      this.populateCustomAdjustFields();
    }
  }

  populateCustomAdjustFields() {
    if (!this.selectedFood) return;
    const amount = parseFloat(document.getElementById('serving-amount').value) || 100;
    const food = this.selectedFood;
    const factor = amount / 100;

    document.getElementById('custom-calories').value = Math.round(food.calories_per_100g * factor);
    document.getElementById('custom-protein').value = ((food.protein_per_100g || 0) * factor).toFixed(1);
    document.getElementById('custom-carbs').value = ((food.carbs_per_100g || 0) * factor).toFixed(1);
    document.getElementById('custom-fat').value = ((food.fat_per_100g || 0) * factor).toFixed(1);
  }

  onCustomAdjustInput() {
    const cal = parseFloat(document.getElementById('custom-calories').value) || 0;
    const prot = parseFloat(document.getElementById('custom-protein').value) || 0;
    const carb = parseFloat(document.getElementById('custom-carbs').value) || 0;
    const fat = parseFloat(document.getElementById('custom-fat').value) || 0;

    document.getElementById('preview-calories').textContent = Math.round(cal);
    document.getElementById('preview-protein').textContent = prot.toFixed(1) + 'g';
    document.getElementById('preview-carbs').textContent = carb.toFixed(1) + 'g';
    document.getElementById('preview-fat').textContent = fat.toFixed(1) + 'g';
  }

  updateNutritionPreview() {
    if (!this.selectedFood) return;
    const amount = parseFloat(document.getElementById('serving-amount').value) || 0;
    const food = this.selectedFood;
    const factor = amount / 100;

    document.getElementById('preview-calories').textContent = Math.round(food.calories_per_100g * factor);
    document.getElementById('preview-protein').textContent = (food.protein_per_100g * factor).toFixed(1) + 'g';
    document.getElementById('preview-carbs').textContent = (food.carbs_per_100g * factor).toFixed(1) + 'g';
    document.getElementById('preview-fat').textContent = (food.fat_per_100g * factor).toFixed(1) + 'g';

    // If custom adjust section is open, populate it too
    const adjustFields = document.getElementById('custom-adjust-fields');
    if (adjustFields && !adjustFields.classList.contains('hidden')) {
      this.populateCustomAdjustFields();
    }
  }

  async confirmFoodLog() {
    if (!this.selectedFood) return;
    const amount = parseFloat(document.getElementById('serving-amount').value) || 0;
    if (amount <= 0) { this.toast('Enter a valid serving size'); return; }

    const food = this.selectedFood;
    const factor = amount / 100;
    const adjustFields = document.getElementById('custom-adjust-fields');
    const isAdjusted = adjustFields && !adjustFields.classList.contains('hidden');

    let calories, protein_g, carbs_g, fat_g;

    if (isAdjusted) {
      calories = parseInt(document.getElementById('custom-calories').value) || Math.round(food.calories_per_100g * factor);
      protein_g = parseFloat(document.getElementById('custom-protein').value) || Math.round((food.protein_per_100g || 0) * factor * 10) / 10;
      carbs_g = parseFloat(document.getElementById('custom-carbs').value) || Math.round((food.carbs_per_100g || 0) * factor * 10) / 10;
      fat_g = parseFloat(document.getElementById('custom-fat').value) || Math.round((food.fat_per_100g || 0) * factor * 10) / 10;

      // Save custom values for future use if checked
      const saveFutureCheck = document.getElementById('save-custom-future-check');
      if (saveFutureCheck && saveFutureCheck.checked && factor > 0) {
        food.calories_per_100g = Math.round(calories / factor);
        food.protein_per_100g = Math.round((protein_g / factor) * 10) / 10;
        food.carbs_per_100g = Math.round((carbs_g / factor) * 10) / 10;
        food.fat_per_100g = Math.round((fat_g / factor) * 10) / 10;
        food.is_customized = true;
      }
    } else {
      calories = Math.round(food.calories_per_100g * factor);
      protein_g = Math.round((food.protein_per_100g || 0) * factor * 10) / 10;
      carbs_g = Math.round((food.carbs_per_100g || 0) * factor * 10) / 10;
      fat_g = Math.round((food.fat_per_100g || 0) * factor * 10) / 10;
    }

    // Save food item to local cache & increment use count
    food.use_count = (food.use_count || 0) + 1;
    food.last_used_at = new Date().toISOString();
    await this.db.put('food_items', food);

    // Create food log entry
    await this.db.put('food_logs', {
      food_item_id: food.id,
      food_name: food.name,
      calories: calories,
      protein_g: protein_g,
      carbs_g: carbs_g,
      fat_g: fat_g,
      serving_size: amount,
      serving_unit: 'g',
      meal_type: this.selectedMeal,
      date: todayStr(),
      logged_at: new Date().toISOString(),
      is_quick_add: 0
    });

    // Save to 1-Tap Favorites if checked
    const saveFavCheck = document.getElementById('save-as-favorite-check');
    if (saveFavCheck && saveFavCheck.checked) {
      await this.db.put('favorites', {
        name: food.name,
        calories: calories,
        protein_g: protein_g,
        carbs_g: carbs_g,
        fat_g: fat_g,
        serving_size: amount,
        serving_unit: 'g',
        meal_type: this.selectedMeal,
        food_item_id: food.id,
        created_at: new Date().toISOString()
      });
      saveFavCheck.checked = false;
    }

    this.closeModal('food-modal');
    await this.renderDashboard();
    this.toast(`Logged ${calories} kcal ✅`);
  }

  // ── Quick Add ──
  openQuickAddModal() {
    this.showModal('quick-add-modal');
    document.getElementById('quick-add-calories').value = '';
    document.getElementById('quick-add-desc').value = '';
    const quickFavCheck = document.getElementById('quick-add-favorite-check');
    if (quickFavCheck) quickFavCheck.checked = false;

    // Auto-select meal based on time
    const h = new Date().getHours();
    let meal = 'snack';
    if (h < 11) meal = 'breakfast';
    else if (h < 15) meal = 'lunch';
    else if (h < 21) meal = 'dinner';

    document.querySelectorAll('#quick-add-meal-tabs .meal-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.meal === meal);
    });

    setTimeout(() => document.getElementById('quick-add-calories').focus(), 300);
  }

  async handleQuickAdd(e) {
    e.preventDefault();
    const calories = parseInt(document.getElementById('quick-add-calories').value);
    const desc = document.getElementById('quick-add-desc').value.trim() || 'Quick add';
    const mealTab = document.querySelector('#quick-add-meal-tabs .meal-tab.active');
    const meal = mealTab ? mealTab.dataset.meal : 'snack';

    if (!calories || calories <= 0) { this.toast('Enter valid calories'); return; }

    const protein_g = Math.round((calories * 0.25 / 4) * 10) / 10;
    const carbs_g = Math.round((calories * 0.50 / 4) * 10) / 10;
    const fat_g = Math.round((calories * 0.25 / 9) * 10) / 10;

    await this.db.put('food_logs', {
      food_item_id: null,
      food_name: desc,
      calories,
      protein_g,
      carbs_g,
      fat_g,
      serving_size: null,
      serving_unit: null,
      meal_type: meal,
      date: todayStr(),
      logged_at: new Date().toISOString(),
      is_quick_add: 1
    });

    // Save to 1-Tap Favorites if checked
    const quickFavCheck = document.getElementById('quick-add-favorite-check');
    if (quickFavCheck && quickFavCheck.checked) {
      await this.db.put('favorites', {
        name: desc,
        calories: calories,
        protein_g: protein_g,
        carbs_g: carbs_g,
        fat_g: fat_g,
        serving_size: null,
        serving_unit: null,
        meal_type: meal,
        food_item_id: null,
        created_at: new Date().toISOString()
      });
      quickFavCheck.checked = false;
    }

    this.closeModal('quick-add-modal');
    await this.renderDashboard();
    this.toast(`Added ${calories} kcal ⚡`);
  }

  // ── Create Custom Item ──
  openCreateCustomModal() {
    this.showModal('create-custom-modal');
    document.getElementById('new-custom-name').value = '';
    document.getElementById('new-custom-calories').value = '';
    document.getElementById('new-custom-protein').value = '';
    document.getElementById('new-custom-carbs').value = '';
    document.getElementById('new-custom-fat').value = '';
    setTimeout(() => document.getElementById('new-custom-name').focus(), 300);
  }

  async handleCreateCustom(e) {
    e.preventDefault();
    const name = document.getElementById('new-custom-name').value.trim();
    const calories = parseInt(document.getElementById('new-custom-calories').value) || 0;
    const protein_g = parseFloat(document.getElementById('new-custom-protein').value) || 0;
    const carbs_g = parseFloat(document.getElementById('new-custom-carbs').value) || 0;
    const fat_g = parseFloat(document.getElementById('new-custom-fat').value) || 0;

    if (!name || calories <= 0) {
      this.toast('Enter name and valid calories');
      return;
    }

    const customId = 'custom_' + Date.now();
    const foodItem = {
      id: customId,
      name: name,
      brand: 'Custom',
      calories_per_100g: calories,
      protein_per_100g: protein_g,
      carbs_per_100g: carbs_g,
      fat_per_100g: fat_g,
      serving_size_g: 100,
      is_custom: true,
      use_count: 1,
      last_used_at: new Date().toISOString()
    };

    // Save custom food item
    await this.db.put('food_items', foodItem);

    // Create food log entry
    await this.db.put('food_logs', {
      food_item_id: customId,
      food_name: name,
      calories: calories,
      protein_g: protein_g,
      carbs_g: carbs_g,
      fat_g: fat_g,
      serving_size: 100,
      serving_unit: 'g',
      meal_type: this.selectedMeal,
      date: todayStr(),
      logged_at: new Date().toISOString(),
      is_quick_add: 0
    });

    // Save to 1-Tap Favorites if checked
    const favCheck = document.getElementById('new-custom-favorite-check');
    if (favCheck && favCheck.checked) {
      await this.db.put('favorites', {
        name: name,
        calories: calories,
        protein_g: protein_g,
        carbs_g: carbs_g,
        fat_g: fat_g,
        serving_size: 100,
        serving_unit: 'g',
        meal_type: this.selectedMeal,
        food_item_id: customId,
        created_at: new Date().toISOString()
      });
    }

    this.closeModal('create-custom-modal');
    this.closeModal('food-modal');
    await this.renderDashboard();
    this.toast(`Created & Logged ${name} (${calories} kcal) ✏️`);
  }

  // ── Weight Modal ──
  openWeightModal() {
    this.showModal('weight-modal');
    document.getElementById('weight-input').value = '';
    document.getElementById('weight-date-label').textContent = formatDateLong(todayStr());
    setTimeout(() => document.getElementById('weight-input').focus(), 300);
  }

  async handleWeightLog(e) {
    e.preventDefault();
    const weight = parseFloat(document.getElementById('weight-input').value);
    if (!weight || weight < 30 || weight > 300) { this.toast('Enter a valid weight'); return; }

    await this.db.put('weight_logs', {
      date: todayStr(),
      weight_kg: weight,
      logged_at: new Date().toISOString()
    });

    // Update profile weight for adaptive TDEE
    this.profile.current_weight_kg = weight;
    await this.db.put('profile', this.profile);

    this.closeModal('weight-modal');
    await this.renderDashboard();
    this.toast(`Weight logged: ${weight} kg ⚖️`);
  }

  // ── History ──
  async renderHistory() {
    const allLogs = await this.db.getAll('food_logs');
    const weightLogs = await this.db.getAll('weight_logs');

    if (!this.profile) return;
    const tdee = calculateTDEE(this.profile);
    const budget = calculateBudget(tdee, this.profile.deficit_target, this.profile.gender);

    // Group food logs by date
    const byDate = {};
    allLogs.forEach(l => {
      if (!byDate[l.date]) byDate[l.date] = 0;
      byDate[l.date] += l.calories;
    });

    // Get last 14 days
    const days = [];
    for (let i = 0; i < 14; i++) {
      const date = daysAgo(i);
      const consumed = Math.round(byDate[date] || 0);
      days.push({ date, consumed, budget, inDeficit: consumed <= budget && consumed > 0 });
    }

    // Weekly summary (last 7 days with data)
    const weekDays = days.slice(0, 7).filter(d => d.consumed > 0);
    const avgConsumed = weekDays.length ? Math.round(weekDays.reduce((s, d) => s + d.consumed, 0) / weekDays.length) : 0;
    const avgDeficit = avgConsumed > 0 ? budget - avgConsumed : 0;
    const daysInDeficit = weekDays.filter(d => d.inDeficit).length;
    const projectedLoss = avgDeficit > 0 ? (avgDeficit * 7 / 7700).toFixed(2) : '0.00';

    document.getElementById('week-avg-deficit').textContent = avgDeficit > 0 ? `-${avgDeficit}` : avgDeficit;
    document.getElementById('week-avg-deficit').style.color = avgDeficit > 0 ? 'var(--green)' : 'var(--red)';
    document.getElementById('week-days-in-deficit').textContent = `${daysInDeficit}/7`;
    document.getElementById('week-projected-loss').textContent = `${projectedLoss} kg`;

    // Calorie history chart
    const chartDays = [...days].reverse();
    const chartCtx = document.getElementById('calorie-history-chart');
    if (this.calorieChart) this.calorieChart.destroy();

    this.calorieChart = new Chart(chartCtx, {
      type: 'bar',
      data: {
        labels: chartDays.map(d => formatDate(d.date)),
        datasets: [{
          label: 'Consumed',
          data: chartDays.map(d => d.consumed),
          backgroundColor: chartDays.map(d => d.consumed > 0 && d.consumed <= budget ? 'rgba(52, 199, 89, 0.55)' : d.consumed > budget ? 'rgba(231, 76, 60, 0.55)' : 'rgba(0,0,0,0.04)'),
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        ...this.getChartOptions(' kcal'),
        plugins: {
          ...this.getChartOptions(' kcal').plugins,
          annotation: undefined
        },
        scales: {
          ...this.getChartOptions(' kcal').scales,
          y: {
            ...this.getChartOptions(' kcal').scales.y,
            suggestedMax: budget * 1.3
          }
        }
      },
      plugins: [{
        id: 'budgetLine',
        afterDatasetsDraw(chart) {
          const { ctx: c, chartArea: { left, right }, scales: { y } } = chart;
          const yPos = y.getPixelForValue(budget);
          c.save();
          c.strokeStyle = 'rgba(74, 144, 217, 0.45)';
          c.lineWidth = 1.5;
          c.setLineDash([6, 4]);
          c.beginPath();
          c.moveTo(left, yPos);
          c.lineTo(right, yPos);
          c.stroke();
          c.fillStyle = 'rgba(74, 144, 217, 0.65)';
          c.font = '10px Inter';
          c.fillText(`Budget: ${budget}`, left + 4, yPos - 6);
          c.restore();
        }
      }]
    });

    // Day list
    const dayList = document.getElementById('history-day-list');
    dayList.innerHTML = days.map(d => {
      const pct = d.budget > 0 ? Math.min(d.consumed / d.budget * 100, 100) : 0;
      const barClass = d.consumed > 0 && d.consumed <= d.budget ? 'in-deficit' : 'over-budget';
      const statusIcon = d.consumed === 0 ? '—' : (d.inDeficit ? '✅' : '❌');
      return `<div class="day-item">
        <div class="day-item-date">
          <div class="day-item-date-day">${d.date === todayStr() ? 'Today' : formatDate(d.date).split(',')[0]}</div>
          <div class="day-item-date-weekday">${formatDate(d.date).split(', ')[1] || ''}</div>
        </div>
        <div class="day-item-bar"><div class="day-item-bar-fill ${barClass}" style="width:${pct}%"></div></div>
        <div class="day-item-calories">${d.consumed > 0 ? d.consumed : '—'}</div>
        <div class="day-item-status">${statusIcon}</div>
      </div>`;
    }).join('');
  }

  // ── Settings ──
  populateSettings() {
    if (!this.profile) return;
    document.getElementById('settings-name').value = this.profile.name || '';
    document.getElementById('settings-gender').value = this.profile.gender;
    document.getElementById('settings-age').value = this.profile.age;
    document.getElementById('settings-height').value = this.profile.height_cm;
    document.getElementById('settings-activity').value = this.profile.activity_level;
    document.getElementById('settings-deficit').value = this.profile.deficit_target;
    this.updateDeficitLabel('settings');
  }

  async handleSettingsSave(e) {
    e.preventDefault();
    this.profile.name = document.getElementById('settings-name').value.trim();
    this.profile.gender = document.getElementById('settings-gender').value;
    this.profile.age = parseInt(document.getElementById('settings-age').value);
    this.profile.height_cm = parseFloat(document.getElementById('settings-height').value);
    this.profile.activity_level = document.getElementById('settings-activity').value;
    this.profile.deficit_target = parseInt(document.getElementById('settings-deficit').value);

    await this.db.put('profile', this.profile);
    this.toast('Settings saved ✅');
  }

  async exportData() {
    const data = {
      profile: this.profile,
      weight_logs: await this.db.getAll('weight_logs'),
      food_logs: await this.db.getAll('food_logs'),
      food_items: await this.db.getAll('food_items'),
      favorites: await this.db.getAll('favorites'),
      exported_at: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deficit-export-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Data exported 📦');
  }

  async clearData() {
    if (!confirm('⚠️ This will delete ALL your data (food logs, weight history, profile). This cannot be undone.\n\nAre you sure?')) return;
    await this.db.clearStore('profile');
    await this.db.clearStore('weight_logs');
    await this.db.clearStore('food_logs');
    await this.db.clearStore('food_items');
    await this.db.clearStore('favorites');
    this.profile = null;
    this.showView('setup');
    this.toast('All data cleared');
  }

  // ── Modal Helpers ──
  showModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    modal.classList.add('hidden');
    this.selectedFood = null;
  }

  // ── Toast ──
  toast(message) {
    const el = document.getElementById('toast');
    document.getElementById('toast-message').textContent = message;
    el.classList.remove('hidden');
    // Force reflow
    el.offsetHeight;
    el.classList.add('show');
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 300);
    }, 2500);
  }

  // ── Escape HTML ──
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init().catch(err => console.error('App init failed:', err));
});
