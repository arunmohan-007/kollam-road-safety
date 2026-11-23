'use strict';

const el = id => document.getElementById(id);
const fmt = number => new Intl.NumberFormat('en-IN').format(number);
const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const roadColors = { NH: '#246785', SH: '#1d867b', MDR: '#657788' };
const severityColors = { Fatal: '#a71839', 'Grievous injury': '#d17617', 'Minor Injury': '#246aa4', 'Non Injury': '#697887' };
const known = 'Cause not known';
const map = L.map('map', {preferCanvas: true}).setView([8.99, 76.86], 10);
L.control.scale({imperial:false}).addTo(map);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
});
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics and GIS contributors'
});
let base = streets.addTo(map);
let baseName = 'OpenStreetMap';
let datasets;
let bounds;
let spotByRank = new Map();
let filteredSpots = [];
let spotShapes = new Map();
const popup = (title, pairs, extra = '') => '<div class="popup"><h3>' + escapeHtml(title) + '</h3><dl>' +
  pairs.map(([label, value]) => '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl>' + extra + '</div>';

function causeCounts(rows) {
  const counts = new Map();
  for (const row of rows) for (const cause of row.causes) counts.set(cause, (counts.get(cause) ?? 0) + 1);
  return [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function spotDetails(p) {
  const rows = datasets.byRank.get(p.rank);
  const causes = causeCounts(rows);
  const knownCauses = causes.filter(([cause]) => cause !== known);
  const leaders = knownCauses.filter(([,count]) => count === knownCauses[0]?.[1]);
  const summary = leaders.map(([cause,count]) => cause + ' (' + count + ')').join(', ') || 'No cause recorded';
  const list = causes.map(([name,count]) => '<li>' + escapeHtml(name) + ' · ' + count + '</li>').join('');
  return {summary, html: popup('Rank ' + p.rank + ' · ' + p.road_name, [
    ['Road class / part', p.road_class + ' / ' + p.road_part],
    ['NATPAC CSI', p.severity_score], ['MoRTH test', p.morth_test],
    ['Fatal crashes', p.fatal_crashes], ['Grievous crashes', p.grievous_crashes],
    ['People killed', p.people_killed], ['People injured', rows.reduce((n,r) => n + r.grievous + r.minor, 0)],
    ['Chainage', fmt(p.start_m) + '–' + fmt(p.end_m) + ' m along road part'],
    ['Severe crashes by year', [p.crashes_2023,p.crashes_2024,p.crashes_2025].join(' / ')],
    ['Leading recorded cause', summary]
  ], '<details><summary>All reported causes</summary><ul>' + list + '</ul></details>')};
}

const roadsLayer = L.geoJSON(null, {
  style: f => ({color:roadColors[f.properties.roadClass],weight:2.5,opacity:.76,bubblingMouseEvents:false}),
  onEachFeature: (f,l) => {
    const p=f.properties;
    l.bindPopup(popup(p.name,[['Road class',p.roadClass],['Road part',p.part],['Mapped length',fmt(p.length)+' m'],
      ['Matched severe crashes',p.crashes],['Source',p.source]]));
  }
});
const crashesLayer = L.geoJSON(null, {
  pointToLayer: (f,latlng) => L.circleMarker(latlng,{radius:4,bubblingMouseEvents:false,weight:1,color:'#fff',fillOpacity:.85,fillColor:severityColors[f.properties.severity] || '#777'}),
  onEachFeature: (f,l) => {
    const p=f.properties;
    l.bindPopup(popup(p.severity + ' collision',[
      ['Accident year',p.year],['People killed',p.killed],['Grievous injuries',p.grievous],['Minor injuries',p.minor],
      ['Collision type',p.collision || 'Unspecified'],['Reported cause',p.causes.join(', ')],
      ['Matched road',p.road || 'No road within 20 m'],['Snap distance',p.distance == null ? '—' : p.distance+' m'],
      ['Black-spot rank',p.rank ?? '—']
    ]));
  }
});
const spotsLayer = L.geoJSON(null, {
  style: f => ({color:f.properties.severity_score >= 80 ? '#9c153b' : f.properties.severity_score >= 50 ? '#cf384c' : '#ea6547',weight:5,opacity:.92,bubblingMouseEvents:false}),
  onEachFeature: (f,l) => {
    spotShapes.set(f.properties.rank,l);
    l.bindPopup(() => spotDetails(f.properties).html,{maxWidth:390});
  }
});
const toggles = [['roads',roadsLayer],['crashes',crashesLayer],['spots',spotsLayer]];
for (const [id,layer] of toggles) el(id).addEventListener('change',() => {
  if (el(id).checked) layer.addTo(map);
  else map.removeLayer(layer);
  if (map.hasLayer(spotsLayer)) spotsLayer.bringToFront();
});

function setBase(next, name) {
  map.removeLayer(base);
  base = next.addTo(map);
  base.bringToBack();
  baseName = name;
}
for (const item of document.querySelectorAll('input[name="base"]')) {
  item.addEventListener('change', () => {
    if (item.value === 'satellite') setBase(satellite,'Satellite esri');
    else setBase(streets,'OpenStreetMap');
  });
}
map.on('click', e => {
  if (e.originalEvent.defaultPrevented) return;
  L.popup().setLatLng(e.latlng).setContent(popup(baseName,[
    ['Latitude',e.latlng.lat.toFixed(6)],['Longitude',e.latlng.lng.toFixed(6)]
  ])).openOn(map);
});

const views = {map: '', dash: '#dashboard', calculation: '#black-spot-calculation'};
let hasSetDistrictExtent = false;

function fitDistrict() {
  if (!bounds?.isValid()) return;
  map.fitBounds(bounds, {padding: [24, 24]});
  hasSetDistrictExtent = true;
}

function setView(view) {
  for (const name of Object.keys(views)) {
    const active = name === view;
    el(name + '-view').hidden = !active;
    el(name + '-tab').setAttribute('aria-pressed', active);
  }
  el('analysis-controls').hidden = view === 'calculation';
  if (view === 'map') {
    map.invalidateSize();
    if (!hasSetDistrictExtent) fitDistrict();
  }
}

function viewFromLocation() {
  setView(Object.keys(views).find(name => views[name] === location.hash) || 'map');
}

function navigate(view) {
  const destination = views[view];
  if (location.hash !== destination) {
    history.pushState(null, '', location.pathname + location.search + destination);
  }
  setView(view);
}

for (const name of Object.keys(views)) el(name + '-tab').onclick = () => navigate(name);
window.addEventListener('hashchange', viewFromLocation);
el('fit').onclick = fitDistrict;
viewFromLocation();

function openSpot(rank) {
  navigate('map');
  el('spots').checked = true;
  if (!map.hasLayer(spotsLayer)) spotsLayer.addTo(map);
  const layer = spotShapes.get(rank);
  if (!layer) return;
  map.fitBounds(layer.getBounds(),{padding:[50,50],maxZoom:17,animate:false});
  layer.openPopup();
}

function renderTable() {
  const query=el('search').value.trim().toLowerCase();
  const selected=filteredSpots.filter(({properties:p}) => (p.rank+' '+p.road_name+' '+p.road_class).toLowerCase().includes(query));
  el('table').innerHTML = selected.length ? '<table><thead><tr><th>Rank</th><th>Road</th><th>CSI</th><th>Fatal crashes</th><th>Grievous crashes</th><th>People killed</th><th>Leading recorded cause</th></tr></thead><tbody>' +
    selected.map(({properties:p}) => '<tr><td><button data-rank="'+p.rank+'">#'+p.rank+'</button></td><td>'+escapeHtml(p.road_name)+' · '+p.road_class+'</td><td>'+p.severity_score+'</td><td>'+p.fatal_crashes+'</td><td>'+p.grievous_crashes+'</td><td>'+p.people_killed+'</td><td>'+escapeHtml(spotByRank.get(p.rank).summary)+'</td></tr>').join('') +
    '</tbody></table>' : '<p>No black spots match these filters.</p>';
}
el('search').addEventListener('input',renderTable);
for (const id of ['table','shortlist']) el(id).addEventListener('click',event => {
  const button=event.target.closest('[data-rank]');
  if (button) openSpot(Number(button.dataset.rank));
});

function render() {
  if (!datasets) return;
  const year=Number(el('year').value);
  const cls=el('road').value;
  const severity=el('severity').value;
  const cause=el('cause').value;
  const min=Number(el('min').value);
  const matches = p => (!year || p.year===year) && (!severity || p.severity===severity) &&
    (!cause || p.causes.includes(cause)) && (!cls || (p.roadClass || 'unmatched')===cls);
  const rows=datasets.stats.filter(matches);
  const contributing=new Set(rows.map(p=>p.rank).filter(Boolean));
  filteredSpots=datasets.spots.features.filter(({properties:p}) => p.severity_score>=min &&
    (!cls || p.road_class===cls) && (!(year || severity || cause) || contributing.has(p.rank)));
  const max=filteredSpots[0]?.properties;
  const mapped=datasets.crashes.features.filter(f=>matches(f.properties));
  el('count').textContent=fmt(filteredSpots.length);
  el('count-sub').textContent='of '+fmt(datasets.spots.features.length)+' ranked stretches';
  el('max').textContent=max?.severity_score ?? '—';
  el('max-sub').textContent=max ? 'Rank #'+max.rank+' · '+max.road_name : 'No matching black spot';
  el('injured').textContent=fmt(rows.reduce((n,r)=>n+r.grievous+r.minor,0));
  el('killed').textContent=fmt(rows.reduce((n,r)=>n+r.killed,0));
  el('status').textContent=fmt(rows.length)+' workbook crashes · '+fmt(mapped.length)+' mapped points · '+fmt(filteredSpots.length)+' ranked stretches';
  el('shortlist').innerHTML=filteredSpots.slice(0,5).map(({properties:p})=>'<button class="rank-item" data-rank="'+p.rank+'"><span>#'+p.rank+' '+escapeHtml(p.road_name)+'</span><b>CSI '+p.severity_score+'</b></button>').join('') || '<p>No matching stretches.</p>';
  const annual = [2023,2024,2025].filter(y=>!year || y===year).map(y=>{
    const list=rows.filter(r=>r.year===y);
    return [y,list.reduce((n,r)=>n+r.grievous,0),list.reduce((n,r)=>n+r.minor,0),list.reduce((n,r)=>n+r.killed,0)];
  });
  el('annual').innerHTML='<table><thead><tr><th>Year</th><th>Grievous injuries</th><th>Minor injuries</th><th>Total injured</th><th>Killed</th></tr></thead><tbody>'+
    annual.map(([y,g,m,k])=>'<tr><td>'+y+'</td><td>'+fmt(g)+'</td><td>'+fmt(m)+'</td><td>'+fmt(g+m)+'</td><td>'+fmt(k)+'</td></tr>').join('')+'</tbody></table>';
  const causes=causeCounts(rows);
  el('causes').innerHTML=causes.map(([label,count])=>'<div class="bar-row"><span>'+escapeHtml(label)+'</span><span class="track"><i class="bar" style="width:'+(100*count/causes[0][1])+'%"></i></span><b>'+fmt(count)+'</b></div>').join('') || '<p>No matching crash records.</p>';
  roadsLayer.clearLayers().addData(datasets.roads.features.filter(f=>!cls || f.properties.roadClass===cls));
  crashesLayer.clearLayers().addData(mapped);
  spotShapes=new Map();
  spotsLayer.clearLayers().addData(filteredSpots);
  if (map.hasLayer(spotsLayer)) spotsLayer.bringToFront();
  renderTable();
}
el('filters').addEventListener('change',render);
el('filters').addEventListener('reset',()=>setTimeout(render,0));

async function initialize() {
  const names=['roads','crashes','black-spots','statistics'];
  const [roads,crashes,spots,stats]=await Promise.all(names.map(async name=>{
    const response=await fetch('./data/'+name+'.json.gz');
    if (!response.ok) throw Error('Could not load '+name);
    const content = new Uint8Array(await response.arrayBuffer());
    if (content[0] !== 31 || content[1] !== 139) return JSON.parse(new TextDecoder().decode(content));
    const stream = new Blob([content]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  }));
  const byRank=new Map();
  for (const row of stats) if (row.rank) {
    if (!byRank.has(row.rank)) byRank.set(row.rank,[]);
    byRank.get(row.rank).push(row);
  }
  spots.features.sort((a,b)=>a.properties.rank-b.properties.rank);
  datasets={roads,crashes,spots,stats,byRank};
  spotByRank=new Map(spots.features.map(({properties:p})=>[p.rank,spotDetails(p)]));
  for (const [cause] of causeCounts(stats).sort((a,b)=>a[0].localeCompare(b[0]))) {
    el('cause').add(new Option(cause,cause));
  }
  render();
  bounds=roadsLayer.getBounds();
  for (const [id,layer] of toggles) if (el(id).checked) layer.addTo(map);
  if (!el('map-view').hidden) fitDistrict();
}
initialize().catch(error => {
  el('status').textContent=error.message+'. Reload the page or check the hosting path.';
  console.error(error);
});

