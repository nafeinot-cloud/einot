/**
 * Mom Duty Scheduler - Application Logic
 * Supports LocalStorage, Firebase Realtime Database sync,
 * Hebcal Hebrew holidays integration, auto Shabbat generator,
 * recurring treatments, and WhatsApp volunteer requests.
 */

// Sibling Configurations
const SIBLINGS = {
    'נפתלי': { color: 'var(--color-naftali)', initial: 'נ' },
    'דינה': { color: 'var(--color-dina)', initial: 'ד' },
    'צורית': { color: 'var(--color-tzurit)', initial: 'צ' },
    'מאיר': { color: 'var(--color-meir)', initial: 'מ' },
    'אבי': { color: 'var(--color-avi)', initial: 'א' },
    'פנוי': { color: 'var(--color-vacant)', initial: '?' }
};

const SHABBAT_ROTATION = ['נפתלי', 'דינה', 'צורית', 'מאיר'];

// Application State
let state = {
    events: {}, // Keyed by ID: { id, date, time, type, title, assignedTo, notes }
    holidays: {}, // Keyed by date: { title, yomtov }
    deletedHolidays: {}, // Keyed by date: true
    hebrewDates: {}, // Keyed by date: "טז בתמוז תשפ\"ו"
    parashot: {}, // Keyed by date: "פרשת בלק"
    activeFilter: 'all', // 'all', sibling name, or 'פנוי'
    activeView: 'list', // 'list' or 'calendar'
    calendarDate: new Date(), // Currently viewed month in calendar
    firebaseEnabled: true,
    firebaseConfig: {
        projectId: 'einot-52365',
        databaseUrl: 'https://einot-52365-default-rtdb.firebaseio.com/',
        apiKey: '',
        sharedPass: ''
    }
};

// Firebase Reference
let fbDatabaseRef = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    initFirebaseIfEnabled();
    setupEventListeners();
    
    // Load local data first for instant response
    loadLocalEvents();
    render(); // Render local state immediately!
    
    // Fetch system holidays (Hebcal) in the background without blocking the UI
    fetchHebrewHolidays().then(() => {
        render(); // Re-render once holidays and parashot are loaded!
    });
    
    // Start listening to Firebase if enabled
    if (state.firebaseEnabled && fbDatabaseRef) {
        setupFirebaseSync();
    }
});

/* ==========================================================================
   Data & Sync Management
   ========================================================================== */

// Settings loaded dynamically are disabled in favor of hardcoded settings

function initFirebaseIfEnabled() {
    if (!state.firebaseEnabled || !state.firebaseConfig.databaseUrl || !state.firebaseConfig.projectId) {
        return;
    }
    
    try {
        // Check if firebase app is already initialized
        if (firebase.apps.length === 0) {
            firebase.initializeApp({
                apiKey: state.firebaseConfig.apiKey,
                databaseURL: state.firebaseConfig.databaseUrl,
                projectId: state.firebaseConfig.projectId
            });
        }
        fbDatabaseRef = firebase.database().ref('events');
    } catch (e) {
        console.error('Firebase Init Error:', e);
        showToast('שגיאה בחיבור ל-Firebase. בדוק את ההגדרות.', 'error');
        state.firebaseEnabled = false;
    }
}

function setupFirebaseSync() {
    if (!fbDatabaseRef) return;
    
    showSyncIndicator(true, 'מסתנכרן עם הענן...');
    
    // Sync events
    fbDatabaseRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
            state.events = data;
        } else {
            state.events = {};
        }
        localStorage.setItem('mom_duty_events', JSON.stringify(state.events));
        showSyncIndicator(false);
        render();
    }, (error) => {
        console.error('Firebase events sync error:', error);
        showToast('שגיאת חיבור לנתונים בענן. עובד במצב מקומי.', 'error');
        showSyncIndicator(false);
        loadLocalEvents();
        render();
    });

    // Sync deleted holidays
    firebase.database().ref('deletedHolidays').on('value', (snapshot) => {
        const data = snapshot.val();
        state.deletedHolidays = data || {};
        localStorage.setItem('mom_duty_deleted_holidays', JSON.stringify(state.deletedHolidays));
        showSyncIndicator(false);
        render();
    }, (error) => {
        console.error('Firebase sync error:', error);
        showToast('שגיאת סנכרון בענן. עובד במצב מקומי.', 'error');
        showSyncIndicator(false);
        loadLocalEvents();
        render();
    });
}

function loadLocalEvents() {
    const localData = localStorage.getItem('mom_duty_events');
    if (localData) {
        try {
            state.events = JSON.parse(localData);
        } catch (e) {
            console.error('Error parsing local events', e);
            state.events = {};
        }
    }
    const localDeleted = localStorage.getItem('mom_duty_deleted_holidays');
    if (localDeleted) {
        try {
            state.deletedHolidays = JSON.parse(localDeleted);
        } catch (e) {
            console.error('Error parsing local deleted holidays', e);
            state.deletedHolidays = {};
        }
    }
}

function saveEvent(event) {
    state.events[event.id] = event;
    persistEvents();
}

function deleteEvent(eventId) {
    if (state.events[eventId]) {
        delete state.events[eventId];
        persistEvents();
    }
}

function persistEvents() {
    localStorage.setItem('mom_duty_events', JSON.stringify(state.events));
    localStorage.setItem('mom_duty_deleted_holidays', JSON.stringify(state.deletedHolidays));
    
    if (state.firebaseEnabled && fbDatabaseRef) {
        showSyncIndicator(true, 'שומר בענן...');
        
        const updates = {};
        updates['/events'] = state.events;
        updates['/deletedHolidays'] = state.deletedHolidays;
        
        firebase.database().ref().update(updates)
            .then(() => {
                showSyncIndicator(false);
            })
            .catch(err => {
                console.error('Firebase save error:', err);
                showToast('שגיאה בשמירה בענן, נשמר מקומית', 'error');
                showSyncIndicator(false);
            });
    } else {
        render();
    }
}

/* ==========================================================================
   Hebcal API Integration (Jewish Holidays)
   ========================================================================== */

async function fetchHebrewHolidays() {
    const currentYear = new Date().getFullYear();
    showSyncIndicator(true, 'טוען חגים ותאריכים עבריים...');
    
    try {
        state.holidays = {};
        state.hebrewDates = {};
        state.parashot = {};
        
        // Fetch for current and next Gregorian year to cover all upcoming holidays
        const fetchYear = async (year) => {
            const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&year=${year}&lg=he-x-NoNikud&s=on&hdates=on`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('API Error');
            const data = await response.json();
            return data.items || [];
        };
        
        const itemsCurrent = await fetchYear(currentYear);
        const itemsNext = await fetchYear(currentYear + 1);
        const allItems = [...itemsCurrent, ...itemsNext];
        
        allItems.forEach(item => {
            if (item.category === 'holiday') {
                state.holidays[item.date] = {
                    title: item.title,
                    yomtov: item.yomtov || false
                };
            } else if (item.category === 'hdate') {
                state.hebrewDates[item.date] = item.title;
            } else if (item.category === 'parashat') {
                state.parashot[item.date] = item.title;
            }
        });
    } catch (e) {
        console.error('Failed to fetch Hebcal data:', e);
        showToast('לא הצלחנו לטעון חגים עבריים באופן אוטומטי.', 'error');
    } finally {
        showSyncIndicator(false);
    }
}

/* ==========================================================================
   Hebrew Date Converter (Local Offline Helper)
   ========================================================================== */

const HEBREW_DAYS = {
    1: 'א', 2: 'ב', 3: 'ג', 4: 'ד', 5: 'ה', 6: 'ו', 7: 'ז', 8: 'ח', 9: 'ט', 10: 'י',
    11: 'יא', 12: 'יב', 13: 'יג', 14: 'יד', 15: 'טו', 16: 'טז', 17: 'יז', 18: 'יח', 19: 'יט', 20: 'כ',
    21: 'כא', 22: 'כב', 23: 'כג', 24: 'כד', 25: 'כה', 26: 'כו', 27: 'כז', 28: 'כח', 29: 'כט', 30: 'ל'
};

const HEBREW_YEARS = {
    5786: 'תשפ"ו',
    5787: 'תשפ"ז',
    5788: 'תשפ"ח',
    5789: 'תשפ"ט',
    5790: 'תש"ץ',
    5791: 'תשצ"א',
    5792: 'תשצ"ב',
    5793: 'תשצ"ג',
    5794: 'תשצ"ד',
    5795: 'תשצ"ה',
    5796: 'תשצ"ו',
    5797: 'תשצ"ז',
    5798: 'תשצ"ח',
    5799: 'תשצ"ט',
    5800: 'תש"ק'
};

function getHebrewDateString(dateStr) {
    try {
        const dateObj = new Date(dateStr + 'T00:00:00');
        const formatter = new Intl.DateTimeFormat('he-IL-u-ca-hebrew', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        const parts = formatter.formatToParts(dateObj);
        const dayVal = parseInt(parts.find(p => p.type === 'day').value);
        const monthVal = parts.find(p => p.type === 'month').value;
        const yearVal = parseInt(parts.find(p => p.type === 'year').value);
        
        const hebDay = HEBREW_DAYS[dayVal] || dayVal;
        const hebYear = HEBREW_YEARS[yearVal] || `ה'${yearVal}`;
        
        return `${hebDay} ב${monthVal} ${hebYear}`;
    } catch (e) {
        console.error('Error converting Hebrew date:', e);
        return '';
    }
}

/* ==========================================================================
   UI Rendering & Templates
   ========================================================================== */

function render() {
    renderList();
    renderCalendar();
    renderTable();
    updateEventCount();
}

// Helper: Format Gregorian date to beautiful Hebrew string
function formatHebrewDate(dateStr) {
    const date = new Date(dateStr);
    const dayNames = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
    const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
    
    const dayName = dayNames[date.getDay()];
    const dayOfMonth = date.getDate();
    const monthName = monthNames[date.getMonth()];
    const year = date.getFullYear();
    
    return `${dayName}, ${dayOfMonth} ב${monthName} ${year}`;
}

// Helper: Get weekday index (0 = Sun, 6 = Sat)
function getDayOfWeek(dateStr) {
    return new Date(dateStr).getDay();
}

// Get all events merged with virtual holidays
function getMergedEvents() {
    const merged = { ...state.events };
    
    // Merge holidays if they are not already overridden by user events and not deleted
    Object.keys(state.holidays).forEach(date => {
        if (state.deletedHolidays && state.deletedHolidays[date]) {
            return; // Skip deleted holidays
        }
        
        // Check if there is already a holiday event saved on this day
        const existingHoliday = Object.values(state.events).find(e => e.date === date && e.type === 'חג');
        
        if (!existingHoliday) {
            // Create a virtual "vacant" holiday event
            const holidayId = `holiday-virtual-${date}`;
            merged[holidayId] = {
                id: holidayId,
                date: date,
                time: '',
                type: 'חג',
                title: state.holidays[date].title,
                assignedTo: 'פנוי',
                notes: '',
                isVirtual: true
            };
        }
    });
    
    return merged;
}

function renderList() {
    const container = document.getElementById('eventList');
    const merged = getMergedEvents();
    
    // Convert to array and filter out past events (keep current day & future)
    const todayStr = new Date().toISOString().split('T')[0];
    
    let eventsArray = Object.values(merged).filter(e => e.date >= todayStr);
    
    // Apply Active Sibling Filter
    if (state.activeFilter !== 'all') {
        eventsArray = eventsArray.filter(e => e.assignedTo === state.activeFilter);
    }
    
    // Sort chronologically (by Date, then Time)
    eventsArray.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (a.time || '00:00').localeCompare(b.time || '00:00');
    });
    
    if (eventsArray.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📅</div>
                <h3>אין אירועים תואמים לסינון זה</h3>
                <p>נסו לבחור סינון אחר או הוסיפו אירועים חדשים.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = eventsArray.map(event => {
        const isVacant = event.assignedTo === 'פנוי';
        const siblingColor = SIBLINGS[event.assignedTo]?.color || 'var(--color-vacant)';
        const siblingInitial = SIBLINGS[event.assignedTo]?.initial || '?';
        
        // Custom styling variables based on type
        let typeClass = 'type-treatment';
        let typeColor = 'var(--color-treatment)';
        let typeBg = 'var(--color-treatment-bg)';
        let typeBorder = 'var(--color-treatment-border)';
        
        if (event.type === 'שבת') {
            typeClass = 'type-shabbat';
            typeColor = 'var(--color-shabbat)';
            typeBg = 'var(--color-shabbat-bg)';
            typeBorder = 'var(--color-shabbat-border)';
        } else if (event.type === 'חג') {
            typeClass = 'type-holiday';
            typeColor = 'var(--color-holiday)';
            typeBg = 'var(--color-holiday-bg)';
            typeBorder = 'var(--color-holiday-border)';
        }
        
        let displayTitle = event.title || (event.type === 'חג' ? event.notes : event.type);
        if (event.type === 'שבת') {
            const parasha = state.parashot[event.date];
            if (parasha) {
                displayTitle = `שבת - ${parasha}`;
            }
        }
        
        // Build notes snippet
        const notesHtml = (event.notes && event.notes !== displayTitle) ? `<div class="card-notes">${event.notes}</div>` : '';
        
        const hebrewDate = getHebrewDateString(event.date);
        const hebrewDateHtml = hebrewDate ? `<div class="card-hebrew-date" style="font-size: 12px; color: var(--text-muted); margin-top: 3px; font-weight: 500;">${hebrewDate}</div>` : '';
        
        // WhatsApp button for unassigned events
        const waButton = isVacant ? `
            <button class="whatsapp-share-btn" onclick="shareToWhatsApp('${event.id}')">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.457L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.42 9.864-9.864.002-2.637-1.03-5.115-2.908-6.995-1.878-1.88-4.357-2.912-6.996-2.914-5.441 0-9.866 4.42-9.87 9.865-.001 1.693.443 3.344 1.285 4.808L1.758 22.25l4.889-1.283zM16.92 14.1c-.266-.134-1.58-.78-1.828-.868-.247-.09-.427-.134-.607.135-.18.267-.697.868-.853 1.047-.158.179-.315.2-.58.067-.266-.134-1.126-.416-2.146-1.326-.793-.708-1.329-1.582-1.486-1.848-.158-.266-.017-.41.117-.542.12-.12.266-.31.4-.467.135-.156.18-.267.27-.446.09-.178.045-.334-.022-.468-.067-.134-.607-1.46-.83-2.003-.218-.524-.46-.453-.607-.46l-.52-.01c-.18 0-.473.067-.72.333-.247.267-.945.923-.945 2.25 0 1.328.966 2.612 1.1 2.79.135.18 1.9 2.9 4.606 4.07.644.278 1.147.444 1.54.568.647.206 1.237.177 1.703.107.519-.078 1.58-.646 1.804-1.24.225-.594.225-1.102.157-1.202-.067-.1-.247-.145-.513-.28z"/></svg>
                <span>בקש התנדבות</span>
            </button>
        ` : '';
        
        return `
            <div class="duty-card" style="--type-color: ${typeColor}; --type-bg: ${typeBg}; --type-border: ${typeBorder};">
                <div class="card-top">
                    <div class="card-date-info">
                        <span class="card-day">${formatHebrewDate(event.date)}</span>
                        ${hebrewDateHtml}
                    </div>
                    <span class="card-type-tag">${event.type}</span>
                </div>
                <div class="card-title-row" style="font-size: 16px; font-weight: 800; margin: 6px 0; color: var(--text-primary);">
                    ${displayTitle}
                </div>
                <div class="card-middle">
                    <div class="assignee-info">
                        <div class="avatar" style="--sibling-color: ${siblingColor};">
                            ${siblingInitial}
                        </div>
                        <span class="assignee-name ${isVacant ? 'unassigned' : ''}">
                            ${isVacant ? 'פנוי - דרוש שיבוץ' : event.assignedTo}
                        </span>
                    </div>
                    ${event.time ? `
                    <div class="time-info">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <span>${event.time}</span>
                    </div>` : ''}
                </div>
                ${notesHtml}
                <div class="card-actions">
                    ${waButton}
                    <button class="card-calendar-btn" onclick="event.stopPropagation(); openCalendarExportModal('${event.id}')">📅 הוסף ליומן</button>
                    <button class="card-edit-btn" onclick="event.stopPropagation(); openEditModal('${event.id}')">שינוי שיבוץ / עריכה</button>
                </div>
            </div>
        `;
    }).join('');
}

function updateEventCount() {
    const todayStr = new Date().toISOString().split('T')[0];
    const merged = getMergedEvents();
    let eventsArray = Object.values(merged).filter(e => e.date >= todayStr);
    
    if (state.activeFilter !== 'all') {
        eventsArray = eventsArray.filter(e => e.assignedTo === state.activeFilter);
    }
    
    document.getElementById('eventCountBadge').textContent = `${eventsArray.length} אירועים`;
}

function renderTable() {
    const tableBody = document.getElementById('tableBody');
    const tableBadge = document.getElementById('tableEventCountBadge');
    if (!tableBody) return;

    const merged = getMergedEvents();
    
    // Convert to array and filter out past events (keep current day & future)
    const todayStr = new Date().toISOString().split('T')[0];
    let eventsArray = Object.values(merged).filter(e => e.date >= todayStr);
    
    // Apply Active Sibling Filter
    if (state.activeFilter !== 'all') {
        eventsArray = eventsArray.filter(e => e.assignedTo === state.activeFilter);
    }
    
    // Sort chronologically
    eventsArray.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (a.time || '00:00').localeCompare(b.time || '00:00');
    });
    
    // Update count badge
    if (tableBadge) {
        tableBadge.innerText = `${eventsArray.length} אירועים`;
    }
    
    if (eventsArray.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 30px; color: var(--text-muted);">
                    אין אירועים תואמים לסינון הנוכחי.
                </td>
            </tr>
        `;
        return;
    }
    
    tableBody.innerHTML = eventsArray.map(event => {
        const isVacant = event.assignedTo === 'פנוי';
        const siblingColor = SIBLINGS[event.assignedTo]?.color || 'var(--color-vacant)';
        const siblingInitial = SIBLINGS[event.assignedTo]?.initial || '?';
        
        let typeBadgeClass = 'badge-treatment';
        if (event.type === 'שבת') {
            typeBadgeClass = 'badge-shabbat';
        } else if (event.type === 'חג') {
            typeBadgeClass = 'badge-holiday';
        }
        
        let displayTitle = event.title || (event.type === 'חג' ? event.notes : event.type);
        if (event.type === 'שבת') {
            const parasha = state.parashot[event.date];
            if (parasha) {
                displayTitle = `שבת - ${parasha}`;
            }
        }
        
        const hebrewDate = getHebrewDateString(event.date);
        const gregorianFormatted = formatHebrewDate(event.date);
        
        const dayOfWeek = gregorianFormatted.split(',')[0];
        const dateNumbers = gregorianFormatted.split(',')[1] || gregorianFormatted;
        
        // Actions
        const waButton = isVacant ? `
            <button class="table-btn-icon" title="בקש התנדבות בוואטסאפ" onclick="event.stopPropagation(); shareToWhatsApp('${event.id}')">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.457L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.825 1.451 5.436 0 9.86-4.42 9.864-9.864.002-2.637-1.03-5.115-2.908-6.995-1.878-1.88-4.357-2.912-6.996-2.914-5.441 0-9.866 4.42-9.87 9.865-.001 1.693.443 3.344 1.285 4.808L1.758 22.25l4.889-1.283zM16.92 14.1c-.266-.134-1.58-.78-1.828-.868-.247-.09-.427-.134-.607.135-.18.267-.697.868-.853 1.047-.158.179-.315.2-.58.067-.266-.134-1.126-.416-2.146-1.326-.793-.708-1.329-1.582-1.486-1.848-.158-.266-.017-.41.117-.542.12-.12.266-.31.4-.467.135-.156.18-.267.27-.446.09-.178.045-.334-.022-.468-.067-.134-.607-1.46-.83-2.003-.218-.524-.46-.453-.607-.46l-.52-.01c-.18 0-.473.067-.72.333-.247.267-.945.923-.945 2.25 0 1.328.966 2.612 1.1 2.79.135.18 1.9 2.9 4.606 4.07.644.278 1.147.444 1.54.568.647.206 1.237.177 1.703.107.519-.078 1.58-.646 1.804-1.24.225-.594.225-1.102.157-1.202-.067-.1-.247-.145-.513-.28z"/></svg>
            </button>
        ` : '';
        
        return `
            <tr style="cursor: pointer;" onclick="openEditModal('${event.id}')">
                <td class="table-date-cell">
                    <div><strong>${dayOfWeek}</strong>, ${dateNumbers}</div>
                    <div class="table-hebrew-date">${hebrewDate}</div>
                </td>
                <td>
                    <span class="table-type-badge ${typeBadgeClass}">${event.type}</span>
                </td>
                <td>
                    <div style="font-weight: 700;">${displayTitle}</div>
                    ${event.time ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">🕒 ${event.time}</div>` : ''}
                    ${(event.notes && event.notes !== displayTitle) ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">📝 ${event.notes}</div>` : ''}
                </td>
                <td>
                    <div class="table-assignee-cell">
                        <div class="avatar" style="--sibling-color: ${siblingColor}; width: 24px; height: 24px; font-size: 11px;">
                            ${siblingInitial}
                        </div>
                        <span class="${isVacant ? 'text-danger' : ''}" style="font-weight: 600;">
                            ${isVacant ? 'פנוי - דרוש שיבוץ' : event.assignedTo}
                        </span>
                    </div>
                </td>
                <td>
                    <div class="table-actions-cell">
                        ${waButton}
                        <button class="table-btn-icon" title="הוסף ליומן האישי" onclick="event.stopPropagation(); openCalendarExportModal('${event.id}')">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                        </button>
                        <button class="table-btn-icon" title="עריכת תורנות" onclick="event.stopPropagation(); openEditModal('${event.id}')">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderCalendar() {
    const daysContainer = document.getElementById('calendarDays');
    const monthYearTitle = document.getElementById('currentMonthYear');
    
    const year = state.calendarDate.getFullYear();
    const month = state.calendarDate.getMonth();
    
    // Set Header Title: e.g. "יולי 2026"
    const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
    monthYearTitle.textContent = `${monthNames[month]} ${year}`;
    
    // Days calculation
    const firstDayIndex = new Date(year, month, 1).getDay(); // Sunday is 0
    const totalDays = new Date(year, month + 1, 0).getDate();
    const prevTotalDays = new Date(year, month, 0).getDate();
    
    let cellsHtml = '';
    
    // 1. Render Previous Month Days padding
    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const d = prevTotalDays - i;
        cellsHtml += `<div class="calendar-day-cell other-month"><span class="cell-number">${d}</span></div>`;
    }
    
    const todayStr = new Date().toISOString().split('T')[0];
    const merged = getMergedEvents();
    
    // Group events by date for easy access
    const eventsByDate = {};
    Object.values(merged).forEach(event => {
        if (!eventsByDate[event.date]) {
            eventsByDate[event.date] = [];
        }
        eventsByDate[event.date].push(event);
    });
    
    // 2. Render Current Month Days
    for (let day = 1; day <= totalDays; day++) {
        const monthStr = String(month + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const dateStr = `${year}-${monthStr}-${dayStr}`;
        
        const isToday = dateStr === todayStr;
        const classes = ['calendar-day-cell'];
        if (isToday) classes.push('today');
        
        const dayEvents = eventsByDate[dateStr] || [];
        
        // Generate dot indicators or small names preview
        let indicatorsHtml = '<div class="cell-events">';
        dayEvents.forEach(e => {
            let color = SIBLINGS[e.assignedTo]?.color || 'var(--accent)';
            if (e.assignedTo === 'פנוי') {
                color = 'var(--color-unassigned)';
            }
            
            // Draw a tiny bar with the assignee's name initial and type indicator
            const initial = SIBLINGS[e.assignedTo]?.initial || '?';
            const badgeText = e.assignedTo === 'פנוי' ? 'פנוי' : initial;
            
            indicatorsHtml += `
                <div class="event-bar-preview" style="--sibling-color: ${color};" title="${e.type}: ${e.notes || e.assignedTo}">
                    ${badgeText}
                </div>
            `;
        });
        indicatorsHtml += '</div>';
        
        const hebrewDate = getHebrewDateString(dateStr);
        const hebDay = hebrewDate ? hebrewDate.split(' ')[0] : '';
        
        const isSaturday = new Date(dateStr + 'T00:00:00').getDay() === 6;
        const parasha = isSaturday ? (state.parashot[dateStr] || '') : '';
        const parashaHtml = parasha ? `<div class="cell-parasha" style="font-size: 9px; color: var(--color-shabbat); font-weight: 800; margin-top: 3px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">${parasha.replace('פרשת ', '')}</div>` : '';
        
        cellsHtml += `
            <div class="${classes.join(' ')}" onclick="selectCalendarDay('${dateStr}')" data-date="${dateStr}">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 11px;">
                    <span class="cell-number">${day}</span>
                    <span class="cell-hebrew-number" style="color: var(--text-muted); font-size: 9px; font-weight: 500;">${hebDay}</span>
                </div>
                ${parashaHtml}
                ${indicatorsHtml}
            </div>
        `;
    }
    
    // 3. Render Next Month Days padding (to complete the grid)
    const totalCellsRendered = firstDayIndex + totalDays;
    const remainingCells = (7 - (totalCellsRendered % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        cellsHtml += `<div class="calendar-day-cell other-month"><span class="cell-number">${i}</span></div>`;
    }
    
    daysContainer.innerHTML = cellsHtml;
    
    // If details panel is open, refresh it
    const detailsPanel = document.getElementById('calendarDayDetails');
    if (!detailsPanel.classList.contains('hidden')) {
        const activeDate = detailsPanel.dataset.date;
        if (activeDate) {
            selectCalendarDay(activeDate);
        }
    }
}

function selectCalendarDay(dateStr) {
    const detailsPanel = document.getElementById('calendarDayDetails');
    const title = document.getElementById('detailsDateTitle');
    const container = document.getElementById('detailsEventsContainer');
    
    // Mark cell as selected
    document.querySelectorAll('.calendar-day-cell').forEach(cell => {
        cell.classList.remove('selected');
        if (cell.dataset.date === dateStr) {
            cell.classList.add('selected');
        }
    });
    
    const hebrewDate = getHebrewDateString(dateStr);
    detailsPanel.dataset.date = dateStr;
    detailsPanel.classList.remove('hidden');
    title.innerHTML = `${formatHebrewDate(dateStr)} <div style="font-size:12px; color:var(--text-muted); font-weight:normal; margin-top:4px;">${hebrewDate}</div>`;
    
    const merged = getMergedEvents();
    const dayEvents = Object.values(merged).filter(e => e.date === dateStr);
    
    if (dayEvents.length === 0) {
        container.innerHTML = `<p class="desc-text" style="padding: 10px 0;">אין תורנויות או טיפולים ביום זה.</p>`;
    } else {
        container.innerHTML = dayEvents.map(event => {
            const isVacant = event.assignedTo === 'פנוי';
            const siblingColor = SIBLINGS[event.assignedTo]?.color || 'var(--color-vacant)';
            
            let displayTitle = event.title || (event.type === 'חג' ? event.notes : event.type);
            if (event.type === 'שבת') {
                const parasha = state.parashot[event.date];
                if (parasha) {
                    displayTitle = `שבת - ${parasha}`;
                }
            }
            
            return `
                <div class="duty-card" style="padding: 10px; margin-bottom: 0; --type-color: ${event.type === 'שבת' ? 'var(--color-shabbat)' : event.type === 'חג' ? 'var(--color-holiday)' : 'var(--color-treatment)'}">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="font-size:13px;">${displayTitle} ${event.time ? `(${event.time})` : ''}</strong>
                        <span style="font-size:11px; background:${siblingColor}; color:white; padding:2px 8px; border-radius:10px; font-weight:700;">
                            ${event.assignedTo === 'פנוי' ? 'פנוי' : event.assignedTo}
                        </span>
                    </div>
                    ${(event.notes && event.notes !== displayTitle) ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${event.notes}</div>` : ''}
                    <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:6px;">
                        ${isVacant ? `<button class="whatsapp-share-btn" style="padding:3px 8px; font-size:10px;" onclick="event.stopPropagation(); shareToWhatsApp('${event.id}')">שתף</button>` : ''}
                        <button class="card-calendar-btn" style="padding:3px 8px; font-size:10px;" onclick="event.stopPropagation(); openCalendarExportModal('${event.id}')">📅 יומן</button>
                        <button class="card-edit-btn" style="padding:3px 8px; font-size:10px;" onclick="event.stopPropagation(); openEditModal('${event.id}')">ערוך</button>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    // Setup add button for this specific date
    const addBtn = document.getElementById('addEventForDateBtn');
    addBtn.onclick = () => {
        openAddModal(dateStr);
    };
}

/* ==========================================================================
   Modals & Actions Setup
   ========================================================================== */

function setupEventListeners() {
    // View switches
    document.getElementById('listViewBtn').onclick = () => switchView('list');
    document.getElementById('calendarViewBtn').onclick = () => switchView('calendar');
    document.getElementById('tableViewBtn').onclick = () => switchView('table');
    
    // Add Event Header Buttons
    document.getElementById('addEventListBtn').onclick = () => openAddModal();
    document.getElementById('addEventTableBtn').onclick = () => openAddModal();
    
    // Floating Button
    document.getElementById('fabBtn').onclick = () => {
        const detailsPanel = document.getElementById('calendarDayDetails');
        const isDetailsVisible = !detailsPanel.classList.contains('hidden');
        const selectedDate = isDetailsVisible ? detailsPanel.dataset.date : null;
        openAddModal(selectedDate);
    };
    
    // Shabbat Generator Trigger
    document.getElementById('generateShabbatotBtn').onclick = () => openModal('generatorModal');
    
    // Calendar Export Handlers
    initCalendarExportHandlers();
    
    // Theme toggle
    document.getElementById('themeToggleBtn').onclick = toggleTheme;
    
    // Close Modal buttons
    document.querySelectorAll('.close-modal-btn, .cancel-btn').forEach(btn => {
        btn.onclick = (e) => {
            const overlay = e.target.closest('.modal-overlay');
            if (overlay) closeModal(overlay.id);
        };
    });
    
    // Day details close
    document.getElementById('closeDetailsBtn').onclick = () => {
        document.getElementById('calendarDayDetails').classList.add('hidden');
        document.querySelectorAll('.calendar-day-cell').forEach(c => c.classList.remove('selected'));
    };
    
    // Forms
    document.getElementById('addEventForm').onsubmit = handleAddEventSubmit;
    document.getElementById('editEventForm').onsubmit = handleEditEventSubmit;
    document.getElementById('generatorForm').onsubmit = handleGeneratorSubmit;
    
    // Delete Event Button
    document.getElementById('deleteEventBtn').onclick = handleDeleteEvent;
    
    // Calendar Month navigation
    document.getElementById('prevMonthBtn').onclick = () => {
        state.calendarDate.setMonth(state.calendarDate.getMonth() - 1);
        renderCalendar();
    };
    document.getElementById('nextMonthBtn').onclick = () => {
        state.calendarDate.setMonth(state.calendarDate.getMonth() + 1);
        renderCalendar();
    };
    
    // Filter Badges
    document.getElementById('filterBadgesContainer').onclick = (e) => {
        const badge = e.target.closest('.filter-badge');
        if (!badge) return;
        
        document.querySelectorAll('.filter-badge').forEach(b => b.classList.remove('active'));
        badge.classList.add('active');
        
        state.activeFilter = badge.dataset.sibling;
        render();
    };
    
    // Recurrence Section Reveal Trigger
    const recurringCheckbox = document.getElementById('eventRecurring');
    const recurrenceDetails = document.getElementById('recurrenceDetails');
    recurringCheckbox.onchange = () => {
        if (recurringCheckbox.checked) {
            recurrenceDetails.style.maxHeight = '200px';
        } else {
            recurrenceDetails.style.maxHeight = '0';
        }
    };

    // Event Type Change handler (reveal holiday title input / hide recurrence)
    const eventTypeSelect = document.getElementById('eventType');
    const eventTitleGroup = document.getElementById('eventTitleGroup');
    const recurrenceSection = document.getElementById('recurrenceSection');
    eventTypeSelect.onchange = () => {
        const type = eventTypeSelect.value;
        eventTitleGroup.style.display = type === 'חג' ? 'flex' : 'none';
        recurrenceSection.style.display = type === 'טיפול' ? 'block' : 'none';
    };

    // Edit Event Type Change handler
    const editEventTypeSelect = document.getElementById('editEventType');
    const editEventTitleGroup = document.getElementById('editEventTitleGroup');
    editEventTypeSelect.onchange = () => {
        const type = editEventTypeSelect.value;
        editEventTitleGroup.style.display = type === 'חג' ? 'flex' : 'none';
    };
    
    // Firebase toggle removed since config is hardcoded
}

function switchView(viewName) {
    state.activeView = viewName;
    
    document.getElementById('listViewBtn').classList.toggle('active', viewName === 'list');
    document.getElementById('calendarViewBtn').classList.toggle('active', viewName === 'calendar');
    document.getElementById('tableViewBtn').classList.toggle('active', viewName === 'table');
    
    document.getElementById('listView').classList.toggle('active', viewName === 'list');
    document.getElementById('calendarView').classList.toggle('active', viewName === 'calendar');
    document.getElementById('tableView').classList.toggle('active', viewName === 'table');
    
    render();
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('open');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('open');
}

function openAddModal(prefilledDate = null) {
    const form = document.getElementById('addEventForm');
    form.reset();
    
    // Default to today or prefilled
    const dateInput = document.getElementById('eventDate');
    if (prefilledDate) {
        dateInput.value = prefilledDate;
    } else {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
    
    // Prefill sibling if a specific sibling is active in the filter
    const assigneeSelect = document.getElementById('eventAssignee');
    if (state.activeFilter && state.activeFilter !== 'all' && state.activeFilter !== 'פנוי') {
        assigneeSelect.value = state.activeFilter;
    } else {
        assigneeSelect.value = 'פנוי'; // Default
    }
    
    // Hide recurrence details and holiday fields initially
    document.getElementById('recurrenceDetails').style.maxHeight = '0';
    document.getElementById('recurrenceSection').style.display = 'block'; // defaults to treatment
    document.getElementById('eventTitleGroup').style.display = 'none';
    
    openModal('addEventModal');
}

function openEditModal(eventId) {
    // If it's a virtual event, we must create a default data object before editing
    const merged = getMergedEvents();
    const event = merged[eventId];
    if (!event) return;
    
    const form = document.getElementById('editEventForm');
    form.reset();
    
    // Prefill form
    document.getElementById('editEventId').value = event.id;
    document.getElementById('editEventDate').value = event.date;
    document.getElementById('editEventTime').value = event.time || '';
    document.getElementById('editEventType').value = event.type;
    document.getElementById('editEventAssignee').value = event.assignedTo;
    document.getElementById('editEventNotes').value = event.notes || '';
    
    // Check if holiday to show title group
    const isHoliday = event.type === 'חג';
    document.getElementById('editEventTitleGroup').style.display = isHoliday ? 'flex' : 'none';
    document.getElementById('editEventTitle').value = event.title || '';
    
    openModal('editEventModal');
}

function openSettingsModal() {
    const config = state.firebaseConfig;
    
    document.getElementById('enableFirebase').checked = state.firebaseEnabled;
    document.getElementById('fbProjectId').value = config.projectId || '';
    document.getElementById('fbDatabaseUrl').value = config.databaseUrl || '';
    document.getElementById('fbApiKey').value = config.apiKey || '';
    document.getElementById('fbSharedPass').value = config.sharedPass || '';
    
    const fields = document.getElementById('firebaseConfigFields');
    if (state.firebaseEnabled) {
        fields.classList.add('open');
    } else {
        fields.classList.remove('open');
    }
    
    openModal('settingsModal');
}

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode', !isDark);
    
    // Icon switches
    document.querySelector('.sun-icon').style.display = isDark ? 'block' : 'none';
    document.querySelector('.moon-icon').style.display = isDark ? 'none' : 'block';
    
    showToast(isDark ? 'מצב כהה הופעל' : 'מצב בהיר הופעל', 'success');
}

/* ==========================================================================
   Logic handlers
   ========================================================================== */

function handleAddEventSubmit(e) {
    e.preventDefault();
    
    const date = document.getElementById('eventDate').value;
    const type = document.getElementById('eventType').value;
    const time = document.getElementById('eventTime').value;
    const assignedTo = document.getElementById('eventAssignee').value;
    const notes = document.getElementById('eventNotes').value.trim();
    
    let title = '';
    if (type === 'חג') {
        title = document.getElementById('eventTitle').value.trim() || 'חג';
    } else if (type === 'שבת') {
        title = 'שבת';
    } else {
        title = 'טיפול רפואי';
    }
    
    const isRecurring = document.getElementById('eventRecurring').checked;
    
    if (isRecurring && type === 'טיפול') {
        const frequency = document.getElementById('recurrenceFrequency').value;
        const count = parseInt(document.getElementById('recurrenceCount').value) || 4;
        
        let currentDate = new Date(date);
        const daysToAdd = frequency === 'weekly' ? 7 : 14;
        
        for (let i = 0; i < count; i++) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const eventId = `treatment-${Date.now()}-${i}`;
            
            const event = {
                id: eventId,
                date: dateStr,
                time: time,
                type: type,
                title: title,
                assignedTo: assignedTo,
                notes: notes
            };
            saveEvent(event);
            
            // Increment date
            currentDate.setDate(currentDate.getDate() + daysToAdd);
        }
        showToast(`נוצרו ${count} טיפולים מחזוריים בהצלחה!`, 'success');
    } else {
        const eventId = `event-${Date.now()}`;
        const event = {
            id: eventId,
            date: date,
            time: time,
            type: type,
            title: title,
            assignedTo: assignedTo,
            notes: notes
        };
        saveEvent(event);
        showToast('אירוע חדש נוסף בהצלחה!', 'success');
    }
    
    closeModal('addEventModal');
}

function handleEditEventSubmit(e) {
    e.preventDefault();
    
    const id = document.getElementById('editEventId').value;
    const date = document.getElementById('editEventDate').value;
    const type = document.getElementById('editEventType').value;
    const time = document.getElementById('editEventTime').value;
    const assignedTo = document.getElementById('editEventAssignee').value;
    const notes = document.getElementById('editEventNotes').value.trim();
    
    let title = '';
    if (type === 'חג') {
        title = document.getElementById('editEventTitle').value.trim() || 'חג';
    } else if (type === 'שבת') {
        title = 'שבת';
    } else {
        title = 'טיפול רפואי';
    }
    
    // If it was a virtual holiday (starting with holiday-virtual-), we rename ID to save it permanently
    let finalId = id;
    if (id.startsWith('holiday-virtual-')) {
        finalId = `holiday-saved-${Date.now()}`;
        // If it was in the deleted list for some reason, remove it
        if (state.deletedHolidays && state.deletedHolidays[date]) {
            delete state.deletedHolidays[date];
        }
    }
    
    const event = {
        id: finalId,
        date: date,
        time: time,
        type: type,
        title: title,
        assignedTo: assignedTo,
        notes: notes
    };
    
    saveEvent(event);
    showToast('השינויים נשמרו בהצלחה!', 'success');
    closeModal('editEventModal');
}

function handleDeleteEvent() {
    const id = document.getElementById('editEventId').value;
    const date = document.getElementById('editEventDate').value;
    const type = document.getElementById('editEventType').value;
    
    if (confirm('האם אתה בטוח שברצונך למחוק אירוע זה?')) {
        if (type === 'חג') {
            // Add to deleted holidays list so it doesn't reappear
            state.deletedHolidays[date] = true;
        }
        
        if (!id.startsWith('holiday-virtual-')) {
            deleteEvent(id);
        } else {
            persistEvents(); // Just save the deletedHolidays list
        }
        
        showToast('האירוע נמחק בהצלחה.', 'success');
        closeModal('editEventModal');
    }
}

// Automatic Shabbat Generator
function handleGeneratorSubmit(e) {
    e.preventDefault();
    
    const monthsAhead = parseInt(document.getElementById('generateMonths').value);
    const startingSiblingOption = document.getElementById('startingAssignee').value;
    
    // Read custom rotation array from inputs
    const rotation = [
        document.getElementById('rotSlot0').value,
        document.getElementById('rotSlot1').value,
        document.getElementById('rotSlot2').value,
        document.getElementById('rotSlot3').value
    ];
    
    // 1. Calculate Shabbat dates
    const shabbatDates = [];
    const today = new Date();
    const endDate = new Date();
    endDate.setMonth(today.getMonth() + monthsAhead);
    
    // Find first Friday/Saturday. We target Saturdays.
    let dateCheck = new Date(today);
    while (dateCheck.getDay() !== 6) { // Saturday
        dateCheck.setDate(dateCheck.getDate() + 1);
    }
    
    while (dateCheck <= endDate) {
        shabbatDates.push(dateCheck.toISOString().split('T')[0]);
        dateCheck.setDate(dateCheck.getDate() + 7);
    }
    
    // 2. Identify the starting rotation pointer
    let nextIndex = 0;
    
    if (startingSiblingOption === 'next_in_turn') {
        // Find the absolute latest shabbat in the DB that matches one of our rotation members
        const shabbatot = Object.values(state.events)
            .filter(e => e.type === 'שבת' && rotation.includes(e.assignedTo))
            .sort((a, b) => b.date.localeCompare(a.date)); // descending
            
        if (shabbatot.length > 0) {
            const lastAssignedShabbat = shabbatot[0].assignedTo;
            const lastIdx = rotation.lastIndexOf(lastAssignedShabbat); // Use lastIndexOf to find the position
            nextIndex = (lastIdx + 1) % rotation.length;
        } else {
            nextIndex = 0; // Default to slot 1
        }
    } else if (startingSiblingOption === 'slot0') {
        nextIndex = 0;
    } else if (startingSiblingOption === 'slot1') {
        nextIndex = 1;
    } else if (startingSiblingOption === 'slot2') {
        nextIndex = 2;
    } else if (startingSiblingOption === 'slot3') {
        nextIndex = 3;
    } else {
        // Fallback for old select options
        const idx = rotation.indexOf(startingSiblingOption);
        nextIndex = idx !== -1 ? idx : 0;
    }
    
    // 3. Generate and assign
    let generatedCount = 0;
    shabbatDates.forEach(shabbatDate => {
        // Skip if already in DB
        const exists = Object.values(state.events).some(e => e.date === shabbatDate && e.type === 'שבת');
        if (exists) return;
        
        const assignee = rotation[nextIndex];
        const eventId = `shabbat-${Date.now()}-${generatedCount}`;
        const newShabbat = {
            id: eventId,
            date: shabbatDate,
            time: '',
            type: 'שבת',
            assignedTo: assignee,
            notes: 'שבת משפחתית'
        };
        
        saveEvent(newShabbat);
        generatedCount++;
        
        // Move rotation forward
        nextIndex = (nextIndex + 1) % rotation.length;
    });
    
    showToast(`נוצרו ושובצו ${generatedCount} שבתות חדשות!`, 'success');
    closeModal('generatorModal');
}

function handleFirebaseConfigSubmit(e) {
    e.preventDefault();
    
    const enable = document.getElementById('enableFirebase').checked;
    const config = {
        projectId: document.getElementById('fbProjectId').value.trim(),
        databaseUrl: document.getElementById('fbDatabaseUrl').value.trim(),
        apiKey: document.getElementById('fbApiKey').value.trim(),
        sharedPass: document.getElementById('fbSharedPass').value.trim()
    };
    
    if (enable && (!config.databaseUrl || !config.projectId)) {
        showToast('אנא מלא את כל שדות החובה לסנכרון.', 'error');
        return;
    }
    
    state.firebaseEnabled = enable;
    state.firebaseConfig = config;
    saveSettings();
    
    showToast('הגדרות הסנכרון נשמרו.', 'success');
    closeModal('settingsModal');
    
    // Restart app sync
    if (enable) {
        initFirebaseIfEnabled();
        setupFirebaseSync();
    } else {
        fbDatabaseRef = null;
        loadLocalEvents();
        render();
    }
}

function handleResetApp() {
    if (confirm('⚠️ אזהרה: פעולה זו תמחוק את כל האירועים וההגדרות לצמיתות! האם אתה בטוח?')) {
        state.events = {};
        localStorage.removeItem('mom_duty_events');
        
        if (state.firebaseEnabled && fbDatabaseRef) {
            fbDatabaseRef.set(null);
        }
        
        showToast('כל המידע נמחק בהצלחה.', 'success');
        closeModal('settingsModal');
        render();
    }
}

/* ==========================================================================
   WhatsApp Sharing
   ========================================================================== */

window.shareToWhatsApp = function(eventId) {
    const merged = getMergedEvents();
    const event = merged[eventId];
    if (!event) return;
    
    const dateFormatted = formatHebrewDate(event.date);
    const dayOfWeek = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][getDayOfWeek(event.date)];
    
    let eventName = event.type;
    if (event.type === 'חג' && event.notes) {
        eventName = `חג (${event.notes})`;
    } else if (event.type === 'טיפול') {
        eventName = 'טיפול רפואי (עמילודיאוזיס)';
    }
    
    const timeText = event.time ? ` בשעה ${event.time}` : '';
    const appLink = window.location.origin + window.location.pathname; // Gets clean app root url
    
    const message = `היי כולם, מי יכול להשתבץ ל${eventName} ביום ${dayOfWeek} בתאריך ${dateFormatted}${timeText}?
קישור לאפליקציה לתורנות: ${appLink}`;
    
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');
};

/* ==========================================================================
   Export / Import JSON Data
   ========================================================================== */

function handleExportData() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state.events, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href",     dataStr);
    
    const dateStr = new Date().toISOString().split('T')[0];
    downloadAnchor.setAttribute("download", `תורנות_אמא_גיבוי_${dateStr}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    
    showToast('קובץ גיבוי הורד בהצלחה.', 'success');
}

function handleImportData(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const importedEvents = JSON.parse(evt.target.result);
            
            // Simple validation
            if (typeof importedEvents === 'object' && !Array.isArray(importedEvents)) {
                state.events = { ...state.events, ...importedEvents };
                persistEvents();
                showToast('הנתונים יובאו ומוזגו בהצלחה!', 'success');
                closeModal('settingsModal');
            } else {
                showToast('מבנה הקובץ אינו תקין.', 'error');
            }
        } catch (err) {
            console.error('Import parse error:', err);
            showToast('שגיאה בקריאת הקובץ.', 'error');
        }
    };
    reader.readAsText(file);
}

/* ==========================================================================
   Toast and Indicators
   ========================================================================== */

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let emoji = '✅';
    if (type === 'error') emoji = '❌';
    
    toast.innerHTML = `
        <span>${emoji} ${message}</span>
        <span style="cursor:pointer; margin-right: 10px;" onclick="this.parentElement.remove()">&times;</span>
    `;
    
    container.appendChild(toast);
    
    // Auto remove
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function showSyncIndicator(show, text = 'מסתנכרן...') {
    const indicator = document.getElementById('syncIndicator');
    const textEl = document.getElementById('syncText');
    
    if (show) {
        textEl.textContent = text;
        indicator.classList.remove('hidden');
    } else {
        indicator.classList.add('hidden');
    }
}

/* ==========================================================================
   Calendar Event Export Functionality
   ========================================================================== */

let currentExportEventId = null;

function openCalendarExportModal(eventId) {
    currentExportEventId = eventId;
    openModal('calendarExportModal');
}

function initCalendarExportHandlers() {
    document.getElementById('exportGoogleBtn').onclick = () => {
        if (!currentExportEventId) return;
        exportToGoogleCalendar(currentExportEventId);
        closeModal('calendarExportModal');
    };
    
    document.getElementById('exportIcsBtn').onclick = () => {
        if (!currentExportEventId) return;
        exportToIcsCalendar(currentExportEventId);
        closeModal('calendarExportModal');
    };
}

function getCalendarEventDetails(eventId) {
    const merged = getMergedEvents();
    const event = merged[eventId];
    if (!event) return null;
    
    let displayTitle = event.title || (event.type === 'חג' ? event.notes : event.type);
    if (event.type === 'שבת') {
        const parasha = state.parashot[event.date];
        if (parasha) {
            displayTitle = `שבת - ${parasha}`;
        }
    }
    
    // Add assignee name to calendar title
    const assigneeStr = event.assignedTo === 'פנוי' ? 'דרוש שיבוץ' : event.assignedTo;
    const title = `תורנות אמא: ${displayTitle} (${assigneeStr})`;
    
    // Build description
    const notesStr = event.notes ? `הערות: ${event.notes}` : '';
    const timeStr = event.time ? `שעה: ${event.time}` : '';
    const details = `תורנות אמא מלווה.\n${displayTitle}\nמשובץ: ${assigneeStr}\n${timeStr}\n${notesStr}\nנוצר באמצעות אפליקציית התורנות.`.trim();
    
    const dateStr = event.date; // "YYYY-MM-DD"
    const timeVal = event.time; // "HH:MM"
    
    let isAllDay = !timeVal;
    let startIso, endIso;
    
    if (isAllDay) {
        // All-day: YYYYMMDD
        const start = dateStr.replace(/-/g, '');
        
        // Calculate next day
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        const nextYear = d.getFullYear();
        const nextMonth = String(d.getMonth() + 1).padStart(2, '0');
        const nextDay = String(d.getDate()).padStart(2, '0');
        const end = `${nextYear}${nextMonth}${nextDay}`;
        
        startIso = start;
        endIso = end;
    } else {
        // Timed: YYYYMMDDTHHMMSS (Local Time representation for calendar imports)
        const [hours, minutes] = timeVal.split(':');
        const start = dateStr.replace(/-/g, '') + 'T' + hours.padStart(2, '0') + minutes.padStart(2, '0') + '00';
        
        // Assume 2 hours duration for treatment
        const d = new Date(dateStr + 'T' + timeVal + ':00');
        d.setHours(d.getHours() + 2);
        const endYear = d.getFullYear();
        const endMonth = String(d.getMonth() + 1).padStart(2, '0');
        const endDay = String(d.getDate()).padStart(2, '0');
        const endHours = String(d.getHours()).padStart(2, '0');
        const endMinutes = String(d.getMinutes()).padStart(2, '0');
        const end = `${endYear}${endMonth}${endDay}T${endHours}${endMinutes}00`;
        
        startIso = start;
        endIso = end;
    }
    
    return { title, details, startIso, endIso, isAllDay, event };
}

function exportToGoogleCalendar(eventId) {
    const detailsObj = getCalendarEventDetails(eventId);
    if (!detailsObj) return;
    
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(detailsObj.title)}&dates=${detailsObj.startIso}/${detailsObj.endIso}&details=${encodeURIComponent(detailsObj.details)}&sf=true&output=xml`;
    window.open(url, '_blank');
}

function exportToIcsCalendar(eventId) {
    const detailsObj = getCalendarEventDetails(eventId);
    if (!detailsObj) return;
    
    const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Mom Duty App//NONSGML v1.0//EN',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${detailsObj.event.id}@mom-duty-app`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'}`,
        detailsObj.isAllDay ? `DTSTART;VALUE=DATE:${detailsObj.startIso}` : `DTSTART:${detailsObj.startIso}`,
        detailsObj.isAllDay ? `DTEND;VALUE=DATE:${detailsObj.endIso}` : `DTEND:${detailsObj.endIso}`,
        `SUMMARY:${detailsObj.title}`,
        `DESCRIPTION:${detailsObj.details}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');
    
    try {
        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `mom_duty_${detailsObj.event.date}_${detailsObj.event.type}.ics`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('קובץ יומן הורד בהצלחה. פתחו אותו כדי להוסיף ליומן!', 'success');
    } catch (e) {
        console.error(e);
        showToast('שגיאה ביצירת קובץ היומן', 'error');
    }
}
