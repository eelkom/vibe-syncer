interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  className?: string;
}

const TextField = ({
  id,
  label,
  type = 'text',
  className,
  ...props
}: TextFieldProps) => (
  <div className={className}>
    <label
      htmlFor={id}
      className="mb-2 block text-sm font-medium text-gray-700"
    >
      {label}
    </label>
    <input
      id={id}
      type={type}
      className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      {...props}
    />
  </div>
);

export default TextField;
