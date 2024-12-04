let express = require('express');
let path = require('path');
let cors = require('cors');

let app = express();
app.use(cors());
app.use(express.json());

const { sql } = require('@vercel/postgres');
require('dotenv').config();
const SECRET_KEY = process.env['SECRET_KEY'];

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { resourceLimits } = require('worker_threads');

// Test Route to Check PostgreSQL Version
app.get('/version', async (req, res) => {
  try {
    // Query the database for its version
    const result = await sql`SELECT version()`;
    res.json({ version: result.rows[0].version });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ error: 'Failed to fetch PostgreSQL version' });
  }
});

// Define the verifyToken middleware
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
  try {
    // Hash the password and check the existence of email
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);

    // Check for existing email
    const userResult = await sql`SELECT * FROM users WHERE email = ${email}`;

    // If email already exists, return response
    if (userResult.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // If email doesn't exists, then proceed to register user
    await sql`INSERT INTO users (email, password) VALUES (${email}, ${hashedPassword})`;

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
  try {
    const result = await sql`SELECT * FROM users WHERE email = ${req.body.email}`;

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
  try {
    const result = await sql`SELECT * FROM movies`;

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching movies:', err);
    res.status(500).send('An error occurred while fetching movies');
  }
});

// List movie details
app.get('/movies/:movie_id', async (req, res) => {
  const { movie_id } = req.params;

  try {
    const movieResult = await sql`SELECT * FROM movies WHERE movie_id = ${movie_id}`;

    const dateResult = await sql`
      SELECT DISTINCT date 
      FROM timeslots 
      WHERE movie_id = ${movie_id} 
      ORDER BY date`;

    const movieDetails = movieResult.rows[0];
    const availableDates = dateResult.rows.map(row => row.date);

    res.status(200).json({ movie: movieDetails, available_dates: availableDates });
  } catch (err) {
    console.error('Error fetching movie details:', err);
    res.status(500).send('An error occurred while fetching movies');
  }
});

// List available timeslots
app.get('/movies/:movie_id/availability/:date', async (req, res) => {
  const { movie_id, date } = req.params;

  try {
    const result = await sql`
      SELECT DISTINCT t.timeslot_id, t.start_time, t.end_time
      FROM timeslots t
      WHERE t.movie_id = ${movie_id} AND t.date = ${date}
    `;

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching movie details:', err);
    res.status(500).send('An error occured while fetching movies');
  } 
});

// List available seats
app.get('/movies/:movie_id/:timeslot_id/seats', async (req, res) => {
  const { movie_id, timeslot_id } = req.params;

  try {
    const result = `
      SELECT DISTINCT s.seat_id, s.seat_number, s.booking_status
      FROM seats s
      WHERE s.movie_id = ${movie_id} AND s.timeslot_id = ${timeslot_id}
      ORDER BY s.seat_number ASC
    `;

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
  try {
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    // Check if the booking already exists
    const existingBooking = await sql`SELECT * FROM bookings WHERE movie_id = ${movie_id} AND timeslot_id = ${timeslot_id} AND seat_id = ${seat_id} AND date = ${date}`;

    if (existingBooking.rows.length > 0) {
      // A booking already exists for the given movie, timeslot, seat, and date
      res.status(400).json({ error: 'Booking already exists' });
    } else {
      // Proceed with inserting the new booking
      try {
        const result = await sql`INSERT INTO bookings (movie_id, timeslot_id, seat_id, date, user_id, email) VALUES (${movie_id}, ${timeslot_id}, ${seat_id}, ${date}, ${user_id}, ${email}) RETURNING *`;

        // Check if the insert was successful
        if (result.rows.length > 0) {
          // Retrieve the entire row of the newly created booking
          const newBooking = result.rows[0];
          const { seat_id: bookedSeatId, movie_id: bookedMovieId, timeslot_id: bookedTimeslotId } = newBooking;

          // Update seat booking status
          const updateResult = await sql`
            UPDATE seats
            SET booking_status = 1
            WHERE seat_id = ${bookedSeatId} AND movie_id = ${bookedMovieId} AND timeslot_id = ${bookedTimeslotId}
            RETURNING *;
          `;
          const updatedSeat = updateResult.rows[0];

          if (!updatedSeat) {
            return res.status(404).json({ error: 'Seat not found or update failed' });
          }

          // Respond with the results
          res.status(201).json({ message: 'Booking successful', booking: newBooking, updatedSeat });
        } else {
          res.status(500).json({ error: 'Failed to create booking' });
        }
      } catch (err) {
        console.error('Error: ', err.message);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Edit booking
app.post('/edit-booking/:booking_id', async (req, res) => {
  try {
    const { booking_id } = req.params;
    const { movie_id, timeslot_id, seat_id, date, user_id, email } = req.body;

    await sql`UPDATE bookings SET movie_id = ${movie_id}, timeslot_id = ${timeslot_id}, seat_id = ${seat_id}, date = ${date}, user_id = ${user_id}, email = ${email} WHERE booking_id = ${booking_id}`;

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
  try {
    const { booking_id } = req.params;

    await sql`DELETE FROM bookings WHERE booking_id = ${booking_id}`;

    res.status(200).json({ message: 'Booking deleted successfully' });
  } catch (err) {
    console.error('Error: ', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/bookings/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await sql`
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
      WHERE bookings.user_id = ${user_id}
    `;
    
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