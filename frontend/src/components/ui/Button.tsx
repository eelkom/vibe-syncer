import Loading from '@/components/ui/Loading';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'success';
  loading?: boolean;
}

const Button = ({
  children,
  variant = 'primary',
  loading = false,
  disabled,
  className,
  ...props
}: ButtonProps) => {
  const baseStyle = 'relative w-full px-6 py-3 rounded-lg transition-colors';
  const variants = {
    primary: 'bg-indigo-500 hover:bg-indigo-600 text-white',
    secondary: 'bg-gray-600 hover:bg-gray-700 text-white',
    success: 'bg-green-500 hover:bg-green-600 text-white',
  };

  return (
    <button
      className={clsx(baseStyle, variants[variant], className)}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loading size={64} />
        </div>
      )}
      <span className={loading ? 'opacity-0' : 'opacity-100'}>{children}</span>
    </button>
  );
};

export default Button;
