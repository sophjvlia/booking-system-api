let express = require('express');
let path = require('path');
let cors = require('cors');

let app = express();
app.use(cors());
app.use(express.json());

const { Pool } = require('pg');
require('dotenv').config();
const DATABASE_URL = process.env['DATABASE_URL'];
const SECRET_KEY = process.env['SECRET_KEY'];

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { resourceLimits } = require('worker_threads');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function getPostgresVersion() {
  const client = await pool.connect();

  try {
    const response = await client.query('SELECT version()');
    console.log(response.rows[0]);
  } finally {
    client.release();
  }
}

getPostgresVersion();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname + '/index.html'));
});

// Register user
app.post('/signup', async (req, res) => {
  const client = await pool.connect();

  try {
    // Hash the password and check the existence of email
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);

    // Check for existing email
    const userResult = await client.query('SELECT * FROM users WHERE email = $1', [email]);

    // If email already exists, return response
    if (userResult.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // If email doesn't exists, then proceed to register user
    await client.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Login user
app.post('/login', async (req, res) => {
  const client = await pool.connect();

  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [req.body.email]);

    const user = result.rows[0];

    if (!user) return res.status(400).json({ message: 'Email or password incorrect' });

     const passwordIsValid = await bcrypt.compare(req.body.password, user.password);

    if (!passwordIsValid) return res.status(401).json({ auth: false, token: null });

    var token = jwt.sign({ id: user.user_id, email: user.email }, SECRET_KEY, { expiresIn: 86400 });
    res.status(200).json({ auth: true, token: token });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// List all movies
app.get('/movies', async (req, res) => {
  const client = await pool.connect();

  try {
    const query = 'SELECT * FROM movies';
    const result = await client.query(query);

    res.json(result.rows);
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching movies');
  } finally {
    client.release();
  }
})

// List movie details
app.get('/movies/:movie_id', async (req, res) => {
  const client = await pool.connect();
  const { movie_id } = req.params;

  try {
    const movieQuery = 'SELECT * FROM movies WHERE movie_id = $1';
    const movieResult = await client.query(movieQuery, [movie_id]);

    const dateQuery = 'SELECT DISTINCT date FROM timeslots WHERE movie_id = $1 ORDER BY date';
    const dateResult = await client.query(dateQuery, [movie_id]);

    const movieDetails = movieResult.rows[0];
    const availableDates = dateResult.rows.map(row => row.date);
    

    res.json({ movie: movieDetails, available_dates: availableDates });
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching movies');
  } finally {
    client.release();
  }
});

// List available timeslots
app.get('/movies/:movie_id/availability/:date', async (req, res) => {
  const client = await pool.connect();
  
  const { movie_id, date } = req.params;

  try {
    const query = `
      SELECT DISTINCT t.timeslot_id, t.start_time, t.end_time
      FROM timeslots t
      WHERE t.movie_id = $1 AND t.date = $2
    `;
    const result = await client.query(query, [movie_id, date]);

    res.json(result.rows);
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching movies');
  } finally {
    client.release();
  }
});

// List available seats
app.get('/movies/:movie_id/:timeslot_id/seats', async (req, res) => {
  const client = await pool.connect();

  const { movie_id, timeslot_id } = req.params;

  try {
    const query = `
      SELECT DISTINCT s.seat_id, s.seat_number, s.booking_status
      FROM seats s
      WHERE s.movie_id = $1 AND s.timeslot_id = $2
      ORDER BY s.seat_number ASC
    `;
    const result = await client.query(query, [movie_id, timeslot_id]);

    res.json(result.rows);
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching movies');
  } finally {
    client.release();
  }
});

// Create booking
app.post('/add-booking', async (req, res) => {
  const client = await pool.connect();

  try {
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    // Check if the booking already exists
    const existingBooking = await client.query(
      'SELECT * FROM bookings WHERE movie_id = $1 AND timeslot_id = $2 AND seat_id = $3 AND date = $4',
      [movie_id, timeslot_id, seat_id, date]
    );

    if (existingBooking.rows.length > 0) {
      // A booking already exists for the given movie, timeslot, seat, and date
      res.status(400).json({ error: 'Booking already exists' });
    } else {
      // Proceed with inserting the new booking
      try {
        const result = await client.query(
          'INSERT INTO bookings (movie_id, timeslot_id, seat_id, date, user_id, email) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [movie_id, timeslot_id, seat_id, date, user_id, email]
        );

        // Check if the insert was successful
        if (result.rows.length > 0) {
          res.status(201).json({ message: 'Booking successful', booking: result.rows[0] });
        } else {
          res.status(500).json({ error: 'Failed to create booking' });
        }
      } catch (err) {
        console.error('Error: ', err.message);
        res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Retrieve the entire row of the newly created booking
    const newBooking = result.rows[0];

    if (result.rows.length > 0) {
      const { seat_id, movie_id, timeslot_id } = result.rows[0];
      const updateQuery = `
        WITH selected_seat AS (
          SELECT * FROM seats
          WHERE seat_id = $1 AND movie_id = $2 AND timeslot_id = $3
        )
        UPDATE seats
        SET booking_status = $4
        WHERE seat_id = $1 AND movie_id = $2 AND timeslot_id = $3
        RETURNING selected_seat.*;
      `;
      const params = [seat_id, movie_id, timeslot_id, 1]; // Assuming 1 represents the booked status

      try {
        const updateResult = await client.query(updateQuery, params);
        const updatedSeat = updateResult.rows[0]; // The first row returned by the UPDATE query

        if (updatedSeat) {
          res.status(200).json({ message: 'Seat booking status updated', seat: updatedSeat });
        } else {
          res.status(404).json({ error: 'Seat not found' });
        }
      } catch (err) {
        console.error('Error: ', err.message);
        res.status(500).json({ error: 'Internal server error' });
      }
    } else {
      res.status(404).json({ error: 'Seat not found' });
    }

    res.status(201).json({ message: 'Booking created successfully', booking: newBooking });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Edit booking
app.post('/edit-booking/:booking_id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { booking_id } = req.params;
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    await client.query(
      'UPDATE bookings SET movie_id = $1, timeslot_id = $2, seat_id = $3, date = $4, user_id = $5, email = $6 WHERE booking_id = $7',
      [movie_id, timeslot_id, seat_id, date, user_id, email, booking_id]
    );

    res.status(200).json({ message: 'Booking updated successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete booking
app.post('/delete-booking/:booking_id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { booking_id } = req.params;

    await client.query('DELETE FROM bookings WHERE booking_id = $1', [booking_id]);

    res.status(200).json({ message: 'Booking deleted successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Define the verifyToken middleware
function verifyToken(req, res, next) {
  // Assuming you have a header like 'Authorization: Bearer <token>'
  const bearerHeader = req.headers['authorization'];

  if (typeof bearerHeader !== 'undefined') {
    const bearerToken = bearerHeader.split(' ')[1];
    req.token = bearerToken;
    next(); // Call next middleware or route handler
  } else {
    res.sendStatus(403); // Forbidden if token is not provided
  }
}

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
        timeslots.start_time,
        timeslots.end_time,
        seats.seat_number
      FROM bookings
      JOIN movies ON bookings.movie_id = movies.movie_id
      JOIN timeslots ON bookings.timeslot_id = timeslots.timeslot_id
      JOIN seats ON bookings.seat_id = seats.seat_id
      WHERE bookings.user_id = $1
    `;
    const result = await client.query(query, [user_id]);
    res.status(200).json({ bookings: result.rows });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log('App is listening on port 3000');
});