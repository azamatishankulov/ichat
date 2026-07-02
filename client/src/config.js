const SERVER_URL = process.env.NODE_ENV === 'production'
  ? 'https://ichat-production-e7e3.up.railway.app'
  : 'http://localhost:5000';

export default SERVER_URL;
