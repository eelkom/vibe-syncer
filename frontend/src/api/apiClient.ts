import { ROUTE_PATH } from '@/routes/routePath';
import axios from 'axios';
import { toast } from 'react-toastify';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error('VITE_API_BASE_URL is not defined in environment variables');
}
export { API_BASE_URL };

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

apiClient.interceptors.request.use((config) => {
  const user = JSON.parse(sessionStorage.getItem('user') || 'null');
  const token = user?.token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,

  (error) => {
    const status = error.response?.status;

    switch (status) {
      case 401:
        toast.error('Authentication error. Please create or join room again.');
        sessionStorage.removeItem('user');
        window.location.href = ROUTE_PATH.LANDING;
        break;
      case 404:
        toast.error('Resource not found.');
        break;
      case 500:
        toast.error('Server error. Please try again later.');
        break;
    }

    return Promise.reject(error);
  },
);

export default apiClient;
