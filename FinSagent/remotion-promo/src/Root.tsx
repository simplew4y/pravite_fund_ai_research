import {Composition} from 'remotion';
import {PromoVideo} from './PromoVideo';

export const RemotionRoot = () => {
  return (
    <Composition
      id="FinSagentPromo"
      component={PromoVideo}
      durationInFrames={1536}
      fps={24}
      width={1920}
      height={1080}
    />
  );
};
