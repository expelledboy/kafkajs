const createProducer = require('../../producer')
const createConsumer = require('../index')
const { KafkaJSNonRetriableError } = require('../../errors')

const {
  secureRandom,
  createCluster,
  createTopic,
  newLogger,
  waitForMessages,
  waitForConsumerToJoinGroup,
} = require('testHelpers')

describe('Consumer', () => {
  let groupId, producer, consumer, topics

  beforeEach(async () => {
    topics = [`test-topic-${secureRandom()}`, `test-topic-${secureRandom()}`]
    groupId = `consumer-group-id-${secureRandom()}`

    for (let topic of topics) {
      await createTopic({ topic, partitions: 2 })
    }

    const producerCluster = createCluster()
    producer = createProducer({
      cluster: producerCluster,
      logger: newLogger(),
    })

    const consumerCluster = createCluster()
    consumer = createConsumer({
      cluster: consumerCluster,
      groupId,
      maxWaitTimeInMs: 1,
      maxBytesPerPartition: 180,
      logger: newLogger(),
    })
  })

  afterEach(async () => {
    consumer && (await consumer.disconnect())
    producer && (await producer.disconnect())
  })

  describe('when pausing', () => {
    it('throws an error if the topic is invalid', () => {
      expect(() => consumer.pause([{ topic: null, partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Invalid topic null'
      )
    })

    it('throws an error if Consumer#run has not been called', () => {
      expect(() => consumer.pause([{ topic: 'foo', partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Consumer group was not initialized, consumer#run must be called first'
      )
    })

    it('does not fetch messages for the paused topic', async () => {
      await consumer.connect()
      await producer.connect()

      const key1 = secureRandom()
      const message1 = { key: `key-${key1}`, value: `value-${key1}`, partition: 0 }
      const key2 = secureRandom()
      const message2 = { key: `key-${key2}`, value: `value-${key2}`, partition: 1 }

      for (let topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message1] })
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      await waitForConsumerToJoinGroup(consumer)
      await waitForMessages(messagesConsumed, { number: 2 })

      const [pausedTopic, activeTopic] = topics
      consumer.pause([{ topic: pausedTopic }])

      for (let topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message2] })
      }

      const consumedMessages = await waitForMessages(messagesConsumed, { number: 3 })

      expect(consumedMessages.filter(({ topic }) => topic === pausedTopic)).toEqual([
        {
          topic: pausedTopic,
          partition: expect.any(Number),
          message: expect.objectContaining({ offset: '0' }),
        },
      ])

      const byPartition = (a, b) => a.partition - b.partition
      expect(
        consumedMessages.filter(({ topic }) => topic === activeTopic).sort(byPartition)
      ).toEqual([
        {
          topic: activeTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        },
        {
          topic: activeTopic,
          partition: 1,
          message: expect.objectContaining({ offset: '0' }),
        },
      ])
    })
  })

  describe('when all topics are paused', () => {
    it('does not fetch messages and wait maxWaitTimeInMs per attempt', async () => {
      const consumerCluster = createCluster()
      consumer = createConsumer({
        cluster: consumerCluster,
        groupId,
        maxWaitTimeInMs: 100,
        maxBytesPerPartition: 180,
        logger: newLogger(),
      })

      await producer.connect()
      await consumer.connect()

      const [topic1, topic2] = topics
      await consumer.subscribe({ topic: topic1, fromBeginning: true })
      await consumer.subscribe({ topic: topic2, fromBeginning: true })

      const eachMessage = jest.fn()
      consumer.run({ eachMessage })
      await waitForConsumerToJoinGroup(consumer)

      consumer.pause([{ topic: topic1 }, { topic: topic2 }])

      const key1 = secureRandom()
      const message1 = { key: `key-${key1}`, value: `value-${key1}`, partition: 0 }

      await producer.send({ acks: 1, topic: topic1, messages: [message1] })
      await producer.send({ acks: 1, topic: topic2, messages: [message1] })

      expect(eachMessage).not.toHaveBeenCalled()
    })
  })

  describe('when resuming', () => {
    it('throws an error if the topic is invalid', () => {
      expect(() => consumer.pause([{ topic: null, partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Invalid topic null'
      )
    })

    it('throws an error if Consumer#run has not been called', () => {
      expect(() => consumer.pause([{ topic: 'foo', partitions: [0] }])).toThrow(
        KafkaJSNonRetriableError,
        'Consumer group was not initialized, consumer#run must be called first'
      )
    })

    it('resumes fetching from the specified topic', async () => {
      await consumer.connect()
      await producer.connect()

      const key = secureRandom()
      const message = { key: `key-${key}`, value: `value-${key}`, partition: 0 }

      for (let topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: true })
      }

      const messagesConsumed = []
      consumer.run({ eachMessage: async event => messagesConsumed.push(event) })

      const [pausedTopic, activeTopic] = topics
      consumer.pause([{ topic: pausedTopic }])

      await waitForConsumerToJoinGroup(consumer)

      for (let topic of topics) {
        await producer.send({ acks: 1, topic, messages: [message] })
      }

      await waitForMessages(messagesConsumed, { number: 1 })

      consumer.resume([{ topic: pausedTopic }])

      await expect(waitForMessages(messagesConsumed, { number: 2 })).resolves.toEqual([
        {
          topic: activeTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        },
        {
          topic: pausedTopic,
          partition: 0,
          message: expect.objectContaining({ offset: '0' }),
        },
      ])
    })
  })
})
