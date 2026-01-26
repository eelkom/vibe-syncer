import Loading from '@/components/ui/Loading';

interface RoomTitleProps {
  isLoading: boolean;
  roomInfos:
    | {
        host_nickname: string;
        name: string;
      }
    | undefined;
}

const RoomTitle = ({ isLoading, roomInfos }: RoomTitleProps) => {
  return (
    <div className="mb-8 text-center">
      <h1 className="text-4xl font-bold text-gray-900">
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loading />
          </div>
        ) : (
          `${roomInfos?.host_nickname}'s ${roomInfos?.name}`
        )}
      </h1>
    </div>
  );
};

export default RoomTitle;
