const Error = () => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/40 backdrop-blur-sm">
      <div className="rounded-xl bg-white p-8 text-center shadow-lg">
        <h2 className="mb-2 text-2xl font-bold text-red-600">Error</h2>
        <p className="text-gray-700">
          Failed to load room info. Please try again.
        </p>
      </div>
    </div>
  );
};

export default Error;
