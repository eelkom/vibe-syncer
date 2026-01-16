import Lottie from 'lottie-react';
import LoadingAnimation from '@/assets/lottie/Loading.json';

const Loading = ({ size = 160 }: { size?: number }) => (
  <div className="flex h-full w-full items-center justify-center">
    <Lottie
      animationData={LoadingAnimation}
      loop
      autoplay
      style={{
        width: size,
        height: size,
        margin: 0,
        padding: 0,
        display: 'block',
      }}
    />
  </div>
);

export default Loading;
