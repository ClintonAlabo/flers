const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');  // Add this for reliable paths

dotenv.config();

const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');

// Configure WebSocket to fix 'undefined' error
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Test connection and enable postgis extension if not already
async function testConnection() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');
  const { rows } = await pool.query('SELECT NOW()');
  console.log('Connected to Neon:', rows[0]);
}
testConnection().catch(err => console.error('DB connection test failed:', err));

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from 'public' folder reliably
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const orsApiKey = process.env.ORS_API_KEY;

// API endpoint for getting top 3 facilities
app.get('/api/facilities', async (req, res) => {
  const { type, lat, lon } = req.query;
  if (!type || !lat || !lon) {
    return res.status(400).json({ error: 'Type, lat, and lon are required' });
  }

  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);

  try {
    // Fetch facilities with geo_distance calculated in DB, pre-sorted by geo_distance and limited to top 20
    const { rows } = await pool.query(`
      SELECT *,
        ST_Distance(ST_MakePoint($2, $3)::geography, ST_MakePoint(longitude, latitude)::geography)/1000 AS geo_distance
      FROM facilities
      WHERE type = $1
      ORDER BY geo_distance ASC
      LIMIT 20
    `, [type, parsedLon, parsedLat]);

    if (rows.length === 0) {
      return res.json([]);
    }

    // Prepare locations: user as first, then facilities
    const locations = [[parsedLon, parsedLat]];
    const destinations = [];
    rows.forEach((f, index) => {
      locations.push([f.longitude, f.latitude]);
      destinations.push(index + 1);
    });

    // Call ORS matrix for accurate driving distances and durations
    const orsResponse = await axios.post(
      'https://api.openrouteservice.org/v2/matrix/driving-car',
      {
        locations,
        sources: [0],
        destinations,
        metrics: ['distance', 'duration'],
        units: 'km',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orsApiKey}`,
        },
      }
    );

    const distances = orsResponse.data.distances[0];
    const durations = orsResponse.data.durations[0];

    // Map to facilities with driving data
    const facilitiesWithDist = rows.map((f, index) => ({
      ...f,
      distance: distances[index + 1], // skip self
      time: Math.round(durations[index + 1] / 60), // seconds to min
    }));

    // Sort by driving distance (in case geo differed from driving)
    facilitiesWithDist.sort((a, b) => a.distance - b.distance);

    // Top 3
    const top3 = facilitiesWithDist.slice(0, 3);

    res.json(top3);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint for facility details
app.get('/api/facility/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: fac } = await pool.query('SELECT * FROM facilities WHERE id = $1', [id]);
    if (fac.length === 0) {
      return res.status(404).json({ error: 'Facility not found' });
    }

    const { rows: reviews } = await pool.query('SELECT * FROM reviews WHERE facility_id = $1', [id]);

    const averageRating = reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : fac[0].ratings;

    res.json({ facility: fac[0], reviews, averageRating });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint for geocode (for manual location search)
app.get('/api/geocode', async (req, res) => {
  const { text } = req.query;
  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const orsResponse = await axios.get('https://api.openrouteservice.org/geocode/search', {
      params: {
        api_key: orsApiKey,
        text,
        'boundary.country': 'NGA',  // Restrict to Nigeria
        'boundary.bbox': [[6.3818359,4.1265755],[7.1784024,5.2756201]]  // Bounding box for Rivers State, Nigeria
      },
    });

    if (orsResponse.data.features && orsResponse.data.features.length > 0) {
      const coord = orsResponse.data.features[0].geometry.coordinates;
      res.json({ lat: coord[1], lon: coord[0] });
    } else {
      res.status(404).json({ error: 'Location not found' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Geocode error' });
  }
});

// API endpoint for directions (for navigation)
app.post('/api/directions', async (req, res) => {
  const { startLat, startLon, endLat, endLon } = req.body;
  if (!startLat || !startLon || !endLat || !endLon) {
    return res.status(400).json({ error: 'Coordinates required' });
  }

  try {
    const orsResponse = await axios.post(
      'https://api.openrouteservice.org/v2/directions/driving-car',
      {
        coordinates: [[startLon, startLat], [endLon, endLat]],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${orsApiKey}`,
        },
      }
    );

    res.json(orsResponse.data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Directions error' });
  }
});

// For local testing: Listen on port if running directly (ignored on Vercel)
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;