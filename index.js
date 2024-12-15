const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;

// PostgreSQL Pool setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test Route to Check PostgreSQL Version
app.get('/version', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version()');
    client.release();
    res.json({ version: result.rows[0].version });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ error: 'Failed to fetch PostgreSQL version' });
  }
});

// Middleware: verifyToken
function verifyToken(req, res, next) {
  const bearerHeader = req.headers['authorization'];
  if (typeof bearerHeader !== 'undefined') {
    const bearerToken = bearerHeader.split(' ')[1];
    req.token = bearerToken;
    next();
  } else {
    res.sendStatus(403);
  }
}

// Register user
app.post('/signup', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);

    const userResult = await client.query('SELECT * FROM users WHERE email = $1', [email]);

    if (userResult.rows.length > 0) {
      client.release();
      return res.status(400).json({ message: 'Email already registered' });
    }

    await client.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);
    client.release();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Login user
app.post('/login', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    client.release();

    const user = result.rows[0];

    if (!user) return res.status(400).json({ message: 'Email or password incorrect' });

    const passwordIsValid = await bcrypt.compare(password, user.password);
    if (!passwordIsValid) return res.status(401).json({ auth: false, token: null });

    const token = jwt.sign({ id: user.user_id, email: user.email }, SECRET_KEY, { expiresIn: '1d' });
    res.status(200).json({ auth: true, token, user_id: user.user_id });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List all movies
app.get('/movies', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM movies');
    client.release();
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching movies:', err);
    res.status(500).send('An error occurred while fetching movies');
  }
});

// List movie details
app.get('/movies/:movie_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { movie_id } = req.params;
    
    const movieResult = await client.query('SELECT * FROM movies WHERE movie_id = $1', [movie_id]);
    const dateResult = await client.query(
      'SELECT DISTINCT date FROM timeslots WHERE movie_id = $1 ORDER BY date',
      [movie_id]
    );

    client.release();

    res.status(200).json({
      movie: movieResult.rows[0],
      available_dates: dateResult.rows.map((row) => row.date),
    });
  } catch (err) {
    console.error('Error fetching movie details:', err);
    res.status(500).send('An error occurred while fetching movies');
  }
});

// List available timeslots
app.get('/movies/:movie_id/availability/:date', async (req, res) => {
  const client = await pool.connect();
  const { movie_id, date } = req.params;
  try {
    const result = await client.query(
      'SELECT DISTINCT t.timeslot_id, t.start_time, t.end_time FROM timeslots t WHERE t.movie_id = $1 AND t.date = $2',
      [movie_id, date]
    );
    client.release();
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching timeslots:', err);
    res.status(500).send('An error occurred while fetching timeslots');
  }
});

// List available seats
app.get('/movies/:movie_id/:timeslot_id/seats', async (req, res) => {
  const client = await pool.connect();
  try {
    const { movie_id, timeslot_id } = req.params;
    
    const result = await client.query(
      'SELECT s.seat_id, s.seat_number, s.booking_status FROM seats s WHERE s.movie_id = $1 AND s.timeslot_id = $2 ORDER BY s.seat_number ASC',
      [movie_id, timeslot_id]
    );
    client.release();
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching seats:', err);
    res.status(500).send('An error occurred while fetching seats');
  }
});

// Create booking
app.post('/add-booking', async (req, res) => {
  const client = await pool.connect();
  try {
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    const existingBooking = await client.query(
      'SELECT * FROM bookings WHERE movie_id = $1 AND timeslot_id = $2 AND seat_id = $3 AND date = $4',
      [movie_id, timeslot_id, seat_id, date]
    );

    if (existingBooking.rows.length > 0) {
      client.release();
      return res.status(400).json({ error: 'Booking already exists' });
    }

    const newBooking = await client.query(
      'INSERT INTO bookings (movie_id, timeslot_id, seat_id, date, user_id, email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [movie_id, timeslot_id, seat_id, date, user_id, email]
    );

    await client.query(
      'UPDATE seats SET booking_status = 1 WHERE seat_id = $1 AND movie_id = $2 AND timeslot_id = $3',
      [seat_id, movie_id, timeslot_id]
    );

    client.release();

    res.status(201).json({ message: 'Booking successful', booking: newBooking.rows[0] });
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).json({ error: err.message });
  }
});

// Edit booking
app.post('/edit-booking/:booking_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { booking_id } = req.params;
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    const query = `
      UPDATE bookings 
      SET movie_id = $1, timeslot_id = $2, seat_id = $3, date = $4, user_id = $5, email = $6 
      WHERE booking_id = $7
    `;
    const values = [movie_id, timeslot_id, seat_id, date, user_id, email, booking_id];

    await client.query(query, values);

    res.status(200).json({ message: 'Booking updated successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete booking
app.delete('/delete-booking/:booking_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { booking_id } = req.params;

    const query = `DELETE FROM bookings WHERE booking_id = $1`;
    const values = [booking_id];

    await client.query(query, values);

    res.status(200).json({ message: 'Booking deleted successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get bookings for a user
app.get('/bookings/:user_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { user_id } = req.params;

    const query = `
      SELECT 
        bookings.booking_id,
        bookings.date,
        bookings.user_id,
        bookings.email,
        movies.thumbnail_url,
        movies.title,
        movies.movie_id,
        timeslots.start_time,
        timeslots.end_time,
        seats.seat_number
      FROM bookings
      JOIN movies ON bookings.movie_id = movies.movie_id
      JOIN timeslots ON bookings.timeslot_id = timeslots.timeslot_id
      JOIN seats ON bookings.seat_id = seats.seat_id
      WHERE bookings.user_id = $1
    `;
    const values = [user_id];

    const result = await client.query(query, values);

    res.status(200).json({ bookings: result.rows });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname + '/index.html'));
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log('App is listening on port 3000');
});