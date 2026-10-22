import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import Button from './Button';
import Modal from './Modal';

const meta: Meta<typeof Modal> = {
  title: 'UI/Modal',
  component: Modal,
  args: {
    size: 'md',
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
  render: function Render(args) {
    const [open, setOpen] = useState(false);

    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Modal</Button>
        <Modal {...args} open={open} onOpenChange={setOpen}>
          <Modal.Title className="mb-2 text-2xl font-bold text-gray-900">
            Modal Title
          </Modal.Title>
          <Modal.Description className="mb-6 text-sm text-gray-500">
            Modal content goes here.
          </Modal.Description>
          <Modal.Close asChild>
            <Button variant="secondary">Close</Button>
          </Modal.Close>
        </Modal>
      </>
    );
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

export const Medium: Story = {};

export const Small: Story = {
  args: {
    size: 'sm',
  },
};
