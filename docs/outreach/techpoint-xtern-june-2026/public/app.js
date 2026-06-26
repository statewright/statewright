import { createApp, computed, onMounted, ref } from '/vendor/vue.esm-browser.prod.js';

createApp({
  setup() {
    const summary = ref(null);
    const incidents = ref([]);
    const timeline = ref([]);
    const events = ref([]);
    const error = ref(null);
    const selectedSeverity = ref('all');
    const query = ref('');
    const selectedIncidentId = ref(null);
    const severityOptions = ['all', 'critical', 'high', 'medium', 'low'];

    const maxTimelineRisk = computed(() => {
      return Math.max(...timeline.value.map((bucket) => bucket.riskScore), 1);
    });

    const filteredIncidents = computed(() => {
      const needle = query.value.trim().toLowerCase();

      return incidents.value.filter((incident) => {
        const severityMatch = selectedSeverity.value === 'all' || incident.severity === selectedSeverity.value;
        const text = [
          incident.entity,
          incident.severity,
          incident.recommendedAction,
          ...(incident.vendors ?? []),
        ].join(' ').toLowerCase();

        return severityMatch && (!needle || text.includes(needle));
      });
    });

    const selectedIncident = computed(() => {
      return incidents.value.find((incident) => incident.id === selectedIncidentId.value)
        ?? filteredIncidents.value[0]
        ?? null;
    });

    const filteredEvents = computed(() => {
      const needle = query.value.trim().toLowerCase();

      return events.value.filter((event) => {
        const severityMatch = selectedSeverity.value === 'all' || normalizedSeverity(event) === selectedSeverity.value;
        const text = [
          event.vendor,
          event.type,
          eventEntity(event),
          event.severity,
          event.message,
        ].join(' ').toLowerCase();

        return severityMatch && (!needle || text.includes(needle));
      });
    });

    const sourceCounts = computed(() => {
      return countBy(events.value, (event) => event.vendor);
    });

    const typeCounts = computed(() => {
      return countBy(events.value, (event) => event.type)
        .slice(0, 5);
    });

    const selectedIncidentEvents = computed(() => {
      if (!selectedIncident.value?.entity) {
        return events.value.slice(0, 5);
      }

      const matches = events.value.filter((event) => eventEntity(event) === selectedIncident.value.entity);
      return (matches.length ? matches : events.value).slice(0, 5);
    });

    function widthFor(bucket) {
      return `${(bucket.riskScore / maxTimelineRisk.value) * 100}%`;
    }

    function selectIncident(incident) {
      selectedIncidentId.value = incident.id;
    }

    function countBy(items, keyFn) {
      const counts = new Map();

      for (const item of items) {
        const key = keyFn(item) || 'unknown';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      return Array.from(counts, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    function eventEntity(event) {
      return event.entity ?? event.host ?? event.username ?? event.ip ?? 'unknown';
    }

    function normalizedSeverity(event) {
      const severity = String(event.severity ?? 'low').toLowerCase();
      return severityOptions.includes(severity) ? severity : 'low';
    }

    function formatTime(timestamp) {
      return new Date(timestamp).toISOString().slice(11, 16);
    }

    async function loadDashboard() {
      try {
        const [summaryResponse, incidentsResponse, timelineResponse, eventsResponse] = await Promise.all([
          fetch('/api/summary'),
          fetch('/api/incidents'),
          fetch('/api/timeline'),
          fetch('/api/events'),
        ]);

        summary.value = await summaryResponse.json();
        incidents.value = await incidentsResponse.json();
        timeline.value = await timelineResponse.json();
        events.value = await eventsResponse.json();
        selectedIncidentId.value = incidents.value[0]?.id ?? null;
      } catch (loadError) {
        error.value = loadError.message;
      }
    }

    onMounted(loadDashboard);

    return {
      summary,
      incidents,
      timeline,
      events,
      error,
      widthFor,
      selectedSeverity,
      severityOptions,
      query,
      filteredIncidents,
      filteredEvents,
      sourceCounts,
      typeCounts,
      selectedIncident,
      selectedIncidentEvents,
      selectIncident,
      eventEntity,
      normalizedSeverity,
      formatTime,
    };
  },
  template: `
    <section class="shell">
      <header class="masthead">
        <p class="eyebrow">Xtern AI Workshop</p>
        <h1>Incident Signal Dashboard</h1>
      </header>

      <p v-if="error" class="error">{{ error }}</p>

      <section v-if="summary" class="metrics" aria-label="Summary">
        <article>
          <span>Total events</span>
          <strong>{{ summary.totalEvents }}</strong>
        </article>
        <article>
          <span>Open incidents</span>
          <strong>{{ summary.openIncidents }}</strong>
        </article>
        <article>
          <span>Critical incidents</span>
          <strong>{{ summary.criticalIncidents }}</strong>
        </article>
        <article>
          <span>Top entity</span>
          <strong>{{ summary.topEntity }}</strong>
        </article>
      </section>

      <section class="coverage" aria-label="Source coverage">
        <article>
          <h2>Source Coverage</h2>
          <div class="chips">
            <span v-for="source in sourceCounts" :key="source.name">
              {{ source.name }} <b>{{ source.count }}</b>
            </span>
          </div>
        </article>
        <article>
          <h2>Event Mix</h2>
          <div class="chips">
            <span v-for="type in typeCounts" :key="type.name">
              {{ type.name }} <b>{{ type.count }}</b>
            </span>
          </div>
        </article>
      </section>

      <section class="layout">
        <section class="panel">
          <div class="panel-header">
            <h2>Incident Queue</h2>
            <span>{{ filteredIncidents.length }} shown</span>
          </div>

          <div class="controls" aria-label="Incident filters">
            <input v-model="query" type="search" placeholder="Search entity, vendor, action">
            <div class="severity-filter">
              <button
                v-for="option in severityOptions"
                :key="option"
                type="button"
                :class="{ active: selectedSeverity === option }"
                @click="selectedSeverity = option"
              >
                {{ option }}
              </button>
            </div>
          </div>

          <button
            v-for="incident in filteredIncidents"
            :key="incident.id"
            type="button"
            class="incident"
            :class="{ selected: selectedIncident && selectedIncident.id === incident.id }"
            @click="selectIncident(incident)"
          >
            <div>
              <strong>{{ incident.entity || 'unassigned entity' }}</strong>
              <span>{{ incident.eventCount }} events</span>
            </div>
            <div>
              <span class="badge" :class="incident.severity">{{ incident.severity }}</span>
              <span class="risk">{{ incident.riskScore }}</span>
            </div>
            <p>{{ incident.recommendedAction }}</p>
            <small>{{ incident.vendors.join(', ') }}</small>
          </button>
        </section>

        <section class="panel side-panel">
          <div class="panel-header">
            <h2>Selected Incident</h2>
            <span v-if="selectedIncident">#{{ selectedIncident.id }}</span>
          </div>

          <article v-if="selectedIncident" class="details">
            <div>
              <span>Entity</span>
              <strong>{{ selectedIncident.entity }}</strong>
            </div>
            <div>
              <span>Risk</span>
              <strong>{{ selectedIncident.riskScore }}</strong>
            </div>
            <div>
              <span>Severity</span>
              <strong class="badge" :class="selectedIncident.severity">{{ selectedIncident.severity }}</strong>
            </div>
            <div>
              <span>Evidence</span>
              <strong>{{ selectedIncident.eventCount }} events from {{ selectedIncident.vendors.length }} vendors</strong>
            </div>
            <p>{{ selectedIncident.recommendedAction }}</p>

            <ul class="evidence-list">
              <li v-for="event in selectedIncidentEvents" :key="event.timestamp + event.vendor + event.message">
                <b>{{ formatTime(event.timestamp) }}Z</b>
                <span>{{ event.vendor }}</span>
                <em>{{ event.message }}</em>
              </li>
            </ul>
          </article>

          <div class="panel-header timeline-heading">
            <h2>Hourly Risk</h2>
          </div>
          <div class="timeline">
            <div v-for="bucket in timeline" :key="bucket.hour" class="bucket">
              <span>{{ new Date(bucket.hour).getUTCHours() }}:00Z</span>
              <div>
                <i :style="{ width: widthFor(bucket) }"></i>
              </div>
              <b>{{ bucket.riskScore }}</b>
            </div>
          </div>
        </section>
      </section>

      <section class="panel event-panel">
        <div class="panel-header">
          <h2>Security Event Readout</h2>
          <span>{{ filteredEvents.length }} events</span>
        </div>

        <div class="event-table" role="table" aria-label="Security event readout">
          <div class="event-row event-head" role="row">
            <span>Time</span>
            <span>Source</span>
            <span>Type</span>
            <span>Entity</span>
            <span>Severity</span>
            <span>Message</span>
          </div>
          <div
            v-for="event in filteredEvents"
            :key="event.timestamp + event.vendor + event.message"
            class="event-row"
            role="row"
          >
            <span>{{ formatTime(event.timestamp) }}Z</span>
            <span>{{ event.vendor }}</span>
            <span>{{ event.type }}</span>
            <span>{{ eventEntity(event) }}</span>
            <span><b class="badge" :class="normalizedSeverity(event)">{{ normalizedSeverity(event) }}</b></span>
            <span>{{ event.message }}</span>
          </div>
        </div>
      </section>
    </section>
  `,
}).mount('#app');
