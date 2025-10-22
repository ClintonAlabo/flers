const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // Required for Neon
});

// Test connection
async function testConnection() {
  const { rows } = await pool.query('SELECT NOW()');
  console.log('Connected to Neon:', rows[0]);
}
testConnection();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const orsApiKey = process.env.ORS_API_KEY;

// Helper to prioritize status
const statusPriority = {
  open: 1,
  crowded: 2,
  closed: 3,
};

// API endpoint for getting top 3 facilities
app.get('/api/facilities', async (req, res) => {
  const { type, lat, lon } = req.query;
  if (!type || !lat || !lon) {
    return res.status(400).json({ error: 'Type, lat, and lon are required' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM facilities WHERE type = $1', [type]);
    if (rows.length === 0) {
      return res.json([]);
    }

    // Prepare locations: user as first, then facilities
    const locations = [[parseFloat(lon), parseFloat(lat)]];
    const destinations = [];
    rows.forEach((f, index) => {
      locations.push([f.longitude, f.latitude]);
      destinations.push(index + 1);
    });

    // Call ORS matrix
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

    // Map to facilities
    const facilitiesWithDist = rows.map((f, index) => ({
      ...f,
      distance: distances[index + 1], // skip self
      time: Math.round(durations[index + 1] / 60), // seconds to min
      priority: statusPriority[f.status],
    }));

    // Sort by priority then distance
    facilitiesWithDist.sort((a, b) => a.priority - b.priority || a.distance - b.distance);

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

module.exports = app;