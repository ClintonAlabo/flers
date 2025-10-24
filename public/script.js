// Shared script for all pages

document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.querySelector('.hamburger-menu');
  const nav = document.querySelector('.nav');

  if (hamburger && nav) {
    hamburger.addEventListener('click', () => {
      nav.classList.toggle('show');
      hamburger.classList.toggle('active'); // Optional: for animating the hamburger to X
    });
  }

  // Function to get query param
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  // For location page
  if (window.location.pathname.endsWith('location.html')) {
    const type = getQueryParam('type');

    document.getElementById('device-location-button').addEventListener('click', () => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((position) => {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          window.location.href = `results.html?type=${type}&lat=${lat}&lon=${lon}`;
        }, (error) => {
          alert('Unable to get location: ' + error.message);
        });
      } else {
        alert('Geolocation not supported');
      }
    });

    document.getElementById('search-button').addEventListener('click', async () => {
      const text = document.getElementById('search-input').value;
      if (!text) return alert('Enter a location');

      try {
        const response = await fetch(`/api/geocode?text=${encodeURIComponent(text)}`);
        const data = await response.json();
        if (data.error) return alert(data.error);
        window.location.href = `results.html?type=${type}&lat=${data.lat}&lon=${data.lon}`;
      } catch (error) {
        alert('Geocode failed');
      }
    });
  }

  // For results page
  if (window.location.pathname.endsWith('results.html')) {
    const type = getQueryParam('type');
    const lat = getQueryParam('lat');
    const lon = getQueryParam('lon');

    let map = L.map('map').setView([lat, lon], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    L.marker([lat, lon]).addTo(map).bindPopup('Your Location');

    async function loadFacilities() {
      try {
        const response = await fetch(`/api/facilities?type=${type}&lat=${lat}&lon=${lon}`);
        const facilities = await response.json();

        facilities.forEach((f) => {
          const marker = L.marker([f.latitude, f.longitude]).addTo(map).bindPopup(f.name);
        });

        // Populate cards
        const cards = document.getElementsByClassName('facility-card');
        for (let i = 0; i < facilities.length; i++) {
          const f = facilities[i];
          cards[i].querySelector('.facility-name').textContent = f.name;
          cards[i].querySelector('.status').textContent = f.status;
          cards[i].querySelector('.status').classList.add(`status-${f.status.toLowerCase()}`);
          cards[i].querySelector('.distance').textContent = f.distance + 'km';
          cards[i].querySelector('.time').textContent = f.time + 'mins';
          cards[i].querySelector('.stars').textContent = '★'.repeat(Math.round(f.ratings)) + '☆'.repeat(5 - Math.round(f.ratings));
          cards[i].querySelector('.call-button').href = `tel:${f.contact_call}`;
          cards[i].querySelector('.whatsapp-button').href = `https://wa.me/${f.contact_whatsapp}`;
          cards[i].querySelector('.navigation-button').addEventListener('click', () => showRoute(lat, lon, f.latitude, f.longitude));
          cards[i].querySelector('.details-link').href = `facility.html?id=${f.id}`;
        }
      } catch (error) {
        alert('Failed to load facilities');
      }
    }

    let currentRoute = null;

    async function showRoute(startLat, startLon, endLat, endLon) {
      try {
        const response = await fetch('/api/directions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startLat, startLon, endLat, endLon }),
        });
        const data = await response.json();
        const route = data.routes[0].geometry; // encoded polyline
        const decoded = decodePolyline(route); // need a function to decode

        if (currentRoute) map.removeLayer(currentRoute);
        currentRoute = L.polyline(decoded, {color: 'blue'}).addTo(map);
        map.fitBounds(currentRoute.getBounds());
      } catch (error) {
        alert('Failed to load route');
      }
    }

    // Function to decode ORS polyline (polyline5 or 6, assume 6)
    function decodePolyline(encoded) {
      if (!encoded) return []; // Added check for empty string
      let index = 0, lat = 0, lng = 0;
      const polyline = [];
      while (index < encoded.length) {
        let shift = 0, result = 0, byte;
        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        const dlat = ((result & 1) !== 0 ? ~(result >> 1) : (result >> 1));
        lat += dlat;
        shift = 0;
        result = 0;
        do {
          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        const dlng = ((result & 1) !== 0 ? ~(result >> 1) : (result >> 1));
        lng += dlng;
        polyline.push([lat * 1e-5, lng * 1e-5]);
      }
      return polyline;
    }

    loadFacilities();
  }

  // For facility details page
  if (window.location.pathname.endsWith('facility.html')) {
    const id = getQueryParam('id');

    async function loadFacility() {
      try {
        const response = await fetch(`/api/facility/${id}`);
        const data = await response.json();

        document.getElementById('facility-name').textContent = data.facility.name;
        document.getElementById('facility-address').textContent = data.facility.address;
        document.getElementById('facility-status').textContent = data.facility.status;
        document.getElementById('facility-status').classList.add(`status-${data.facility.status.toLowerCase()}`);
        document.getElementById('facility-contact').textContent = data.facility.contact_call;
        document.getElementById('facility-ratings').textContent = data.averageRating.toFixed(1);

        const reviewsContainer = document.getElementById('reviews');
        data.reviews.forEach(r => {
          const reviewDiv = document.createElement('div');
          reviewDiv.classList.add('review');
          reviewDiv.innerHTML = `<strong>${r.user_name} (${r.rating})</strong>: ${r.review}`;
          reviewsContainer.appendChild(reviewDiv);
        });
      } catch (error) {
        alert('Failed to load facility details');
      }
    }

    loadFacility();
  }
});