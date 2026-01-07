import { clsx } from "clsx";
import type { ReactNode } from "react";

interface ButtonProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
}

const Button = ({ children, variant = "primary", onClick }: ButtonProps) => {
  const baseStyle = "px-4 py-2 rounded-lg font-bold transition-colors";
  const variants = {
    primary: "bg-green-500 hover:bg-green-600 text-white",
    secondary: "bg-gray-700 hover:bg-gray-600 text-white",
    danger: "bg-red-500 hover:bg-red-600 text-white",
  };

  return (
    <button className={clsx(baseStyle, variants[variant])} onClick={onClick}>
      {children}
    </button>
  );
};

export default Button;
