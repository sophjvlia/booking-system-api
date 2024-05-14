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


// Retrieve all users
app.get('/users', async (req, res) => {
  const client = await pool.connect();

  try {
    const query = 'SELECT * FROM users';
    const result = await client.query(query);

    res.json(result.rows);
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching users');
  } finally {
    client.release();
  }
})

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
    const availableDates = dateResult.rows.map(row => row.date.toISOString().split('T')[0]);
    

    res.json({ movie: movieDetails, available_dates: availableDates });
  } catch (err) {
    console.log(err.stack);
    res.status(500).send('An error occured while fetching movies');
  } finally {
    client.release();
  }
});

// List available timeslots and seats
app.get('/movies/:movie_id/availability/:date', async (req, res) => {
  const client = await pool.connect();
  
  const { movie_id, date } = req.params;

  try {
    const query = `
      SELECT DISTINCT t.timeslot_id, t.start_time, t.end_time, ARRAY_AGG(s.seat_number) AS available_seats
      FROM timeslots t
      INNER JOIN seats s ON t.timeslot_id = s.timeslot_id
      WHERE t.movie_id = $1 AND t.date = $2 AND s.booking_status = 0
      GROUP BY t.timeslot_id, t.start_time, t.end_time, t.available_seats
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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log('App is listening on port 3000');
});