import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import Button from './Button';
import ConfirmModal from './ConfirmModal';

const meta: Meta<typeof ConfirmModal> = {
  title: 'UI/ConfirmModal',
  component: ConfirmModal,
  args: {
    title: 'Leave this room?',
    description:
      'If you leave, the music will stop playing and your connection will be lost.',
    confirmLabel: 'Leave Room',
    onConfirm: fn(),
    loading: false,
  },
  render: function Render(args) {
    const [open, setOpen] = useState(false);

    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Confirm Modal</Button>
        <ConfirmModal {...args} open={open} onOpenChange={setOpen} />
      </>
    );
  },
};

export default meta;
type Story = StoryObj<typeof ConfirmModal>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    loading: true,
  },
};
