import type { Meta, StoryObj } from '@storybook/react-vite';
import Error from './Error';

const meta: Meta<typeof Error> = {
  title: 'UI/Error',
  component: Error,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof Error>;

export const Default: Story = {};
