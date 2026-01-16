import { ToastContainer } from 'react-toastify';
import AppRouter from './routes/AppRouter';
import 'react-toastify/dist/ReactToastify.css';
import ErrorBoundary from './components/ErrorBoundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <AppRouter />
        <ToastContainer position="top-right" autoClose={2000} />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

export default App;
