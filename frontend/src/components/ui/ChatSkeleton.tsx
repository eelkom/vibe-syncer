const ChatSkeleton = () => {
  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] rounded-2xl bg-black px-4 py-3">
        <div className="space-y-2">
          <div className="h-4 w-48 animate-pulse rounded bg-gray-700"></div>
          <div className="h-4 w-40 animate-pulse rounded bg-gray-700"></div>
          <div className="h-4 w-32 animate-pulse rounded bg-gray-700"></div>
        </div>
      </div>
    </div>
  );
};

export default ChatSkeleton;
