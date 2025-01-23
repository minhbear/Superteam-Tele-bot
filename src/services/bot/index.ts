import {
  APIGatewayEvent,
  APIGatewayProxyResultV2,
  Context,
  Handler,
} from 'aws-lambda'

export const handler: Handler<
  APIGatewayEvent,
  APIGatewayProxyResultV2
> = async (
  event: APIGatewayEvent,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  try {
    console.log(event)
    console.log(context)
    console.log('Helloooooooooo')

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Hello',
      }),
    }
  } catch (error) {
    console.error(error)
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Server Error',
      }),
    }
  }
}
